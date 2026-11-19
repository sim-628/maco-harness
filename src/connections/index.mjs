import { challenge, failure, nonce, VaultCipher } from './crypto.mjs';
import { authorization, redeemCode, refreshGrant, validateActions } from './oauth.mjs';
import { compatibleProvider, configuredModelBaseUrl } from '../model/endpoint.mjs';

const modelProviders = new Set(['openai', 'anthropic', 'deepseek', compatibleProvider]);
const oauthLifetime = 10 * 60_000;

function sameEpoch(row, expectedEpoch) {
  if (!Number.isSafeInteger(expectedEpoch) || row.epoch !== expectedEpoch) throw failure('connection_changed', 409);
}

function metadata(row) {
  return {
    id: row.id, kind: row.kind, provider: row.provider, status: row.status, epoch: row.epoch,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    actions: JSON.parse(row.actions), scopes: JSON.parse(row.scopes),
  };
}

// Each instance belongs to exactly one user Durable Object. Public reads project
// only connection metadata. Secrets can only be obtained by an epoch-checked call.
export class ConnectionStore {
  #sql;
  #storage;
  #cipher;
  #env;
  #refreshing = new Map();
  #transact;

  constructor(storage, env, {transaction} = {}) {
    this.#storage = storage;
    this.#transact = transaction || (fn => storage.transactionSync(fn));
    this.#env = env;
    this.#sql = storage.sql;
    this.#transact(() => {
      this.#sql.exec('CREATE TABLE IF NOT EXISTS vault_lifecycle (singleton INTEGER PRIMARY KEY,epoch INTEGER NOT NULL)');
      this.#sql.exec('INSERT OR IGNORE INTO vault_lifecycle VALUES (1,1)');
      this.#sql.exec('CREATE TABLE IF NOT EXISTS vault_identity (singleton INTEGER PRIMARY KEY, binding TEXT NOT NULL)');
      this.#sql.exec('INSERT OR IGNORE INTO vault_identity VALUES (1,?)', crypto.randomUUID());
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT,
        status TEXT NOT NULL, epoch INTEGER NOT NULL, actions TEXT NOT NULL,
        scopes TEXT NOT NULL, generation TEXT NOT NULL, sealed TEXT,
        UNIQUE(provider, account_id)
      )`);
      this.#sql.exec('CREATE TABLE IF NOT EXISTS mail_oauth (state TEXT PRIMARY KEY, expires INTEGER NOT NULL, sealed TEXT NOT NULL)');
      // Additive migration leaves existing connection/vault records untouched.
      this.#sql.exec('CREATE TABLE IF NOT EXISTS model_endpoints (connection_id TEXT PRIMARY KEY, base_url TEXT NOT NULL)');
    });
    const vault = this.#first('SELECT binding FROM vault_identity WHERE singleton=1');
    this.#cipher = new VaultCipher(env.CONNECTION_ENCRYPTION_KEY, vault.binding);
  }

  #controlEpoch() { return this.#first('SELECT epoch FROM vault_lifecycle WHERE singleton=1').epoch; }
  #assertControl(epoch) { if (epoch!==this.#controlEpoch()) throw failure('account_generation_changed',409); }
  fence({revokeConnections=false}={}) {
    return this.#transact(()=>{
      this.#sql.exec('UPDATE vault_lifecycle SET epoch=epoch+1 WHERE singleton=1');
      this.#sql.exec('DELETE FROM mail_oauth');
      if (revokeConnections) this.#sql.exec("UPDATE connections SET status='revoked',epoch=epoch+1,sealed=NULL,generation=hex(randomblob(16)),actions='[]',scopes='[]'");
      return {epoch:this.#controlEpoch()};
    });
  }

  #first(sql, ...args) { return this.#sql.exec(sql, ...args).toArray()[0]; }

  #row(id) {
    const row = typeof id === 'string' && this.#first(`SELECT c.*,e.base_url FROM connections c
      LEFT JOIN model_endpoints e ON e.connection_id=c.id WHERE c.id=?`, id);
    if (!row) throw failure('connection_not_found', 404);
    return row;
  }

  #existing(id, epoch, kind, provider) {
    const row = this.#row(id);
    if (row.kind !== kind || row.provider !== provider) throw failure('connection_mismatch', 409);
    sameEpoch(row, epoch);
    return row;
  }

  get(id) { return metadata(this.#row(id)); }

  list() {
    return this.#sql.exec(`SELECT c.id,c.kind,c.provider,c.account_id,c.status,c.epoch,c.scopes,c.actions,e.base_url
      FROM connections c LEFT JOIN model_endpoints e ON e.connection_id=c.id ORDER BY c.id`).toArray().map(metadata);
  }

  assertEpoch(id, expectedEpoch) {
    const row = this.#row(id);
    if (row.status !== 'active') throw failure('connection_revoked', 403);
    sameEpoch(row, expectedEpoch);
    return metadata(row);
  }

  async putModel({ id, expectedEpoch, provider, apiKey, baseUrl },{assertAuthorized}={}) {
    assertAuthorized?.();
    const controlEpoch=this.#controlEpoch();
    if (!modelProviders.has(provider)) throw failure('unknown_model_provider');
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)) throw failure('invalid_api_key');
    const prior = id !== undefined ? this.#existing(id, expectedEpoch, 'model', provider) : null;
    if (id === undefined && expectedEpoch !== undefined) throw failure('connection_changed', 409);
    let endpoint;
    if (provider === compatibleProvider) endpoint = configuredModelBaseUrl(baseUrl ?? prior?.base_url, this.#env.MODEL_PROVIDER_HOSTS);
    else if (baseUrl !== undefined) throw failure('preset_endpoint_fixed');
    const key = id ?? crypto.randomUUID();
    const sealed = await this.#cipher.seal(['model', provider, key], { apiKey });
    return this.#transact(() => {
      this.#assertControl(controlEpoch);
      assertAuthorized?.();
      if (id !== undefined) {
        this.#existing(id, expectedEpoch, 'model', provider);
        this.#sql.exec("UPDATE connections SET sealed=?,generation=?,status='active',epoch=epoch+1 WHERE id=?", sealed, nonce(), key);
      } else {
        this.#sql.exec("INSERT INTO connections VALUES (?,'model',?,NULL,'active',1,'[]','[]',?,?)", key, provider, nonce(), sealed);
      }
      if (endpoint) this.#sql.exec('INSERT INTO model_endpoints VALUES (?,?) ON CONFLICT(connection_id) DO UPDATE SET base_url=excluded.base_url', key, endpoint);
      return this.get(key);
    });
  }

  async beginOAuth({ id, expectedEpoch, provider, actions = [] },{assertAuthorized}={}) {
    assertAuthorized?.();
    const controlEpoch=this.#controlEpoch();
    const allowed = validateActions(provider, actions);
    if (id !== undefined) this.#existing(id, expectedEpoch, 'mail', provider);
    else if (expectedEpoch !== undefined) throw failure('connection_changed', 409);
    const state = nonce();
    const verifier = nonce();
    const { authorizationUrl, scopes, redirect } = authorization(provider, this.#env, {
      actions: allowed, state, codeChallenge: await challenge(verifier),
    });
    const sealed = await this.#cipher.seal(['oauth', state], { id, expectedEpoch, provider, actions: allowed, verifier, redirect, scopes });
    this.#transact(() => {
      this.#assertControl(controlEpoch);
      assertAuthorized?.();
      this.#sql.exec('DELETE FROM mail_oauth WHERE expires<=?', Date.now());
      if (id !== undefined) this.#existing(id, expectedEpoch, 'mail', provider);
      this.#sql.exec('INSERT INTO mail_oauth VALUES (?,?,?)', state, Date.now() + oauthLifetime, sealed);
    });
    return { state, authorizationUrl };
  }

  async completeOAuth({ state, code },{assertAuthorized}={}) {
    assertAuthorized?.();
    const controlEpoch=this.#controlEpoch();
    if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || typeof code !== 'string' || !code || code.length > 8192) throw failure('invalid_oauth_callback');
    // Consume before any provider I/O, so even simultaneous callback deliveries redeem once.
    const saved = this.#transact(() => {
      const row = this.#first('SELECT expires,sealed FROM mail_oauth WHERE state=?', state);
      this.#sql.exec('DELETE FROM mail_oauth WHERE state=?', state);
      return row;
    });
    if (!saved || saved.expires <= Date.now()) throw failure('invalid_oauth_state');
    const txn = await this.#cipher.open(['oauth', state], saved.sealed);
    const { id, expectedEpoch, provider, actions } = txn;
    if (id !== undefined) this.#existing(id, expectedEpoch, 'mail', provider);
    const { secret, scopes, accountId } = await redeemCode(provider, this.#env, code, txn);
    const key = id ?? crypto.randomUUID();
    const sealed = await this.#cipher.seal(['mail', provider, key], secret);
    return this.#transact(() => {
      this.#assertControl(controlEpoch);
      assertAuthorized?.();
      if (id !== undefined) {
        const old = this.#existing(id, expectedEpoch, 'mail', provider);
        if (old.account_id !== accountId) throw failure('mailbox_identity_changed', 409);
        this.#sql.exec("UPDATE connections SET status='active',epoch=epoch+1,actions=?,scopes=?,sealed=?,generation=? WHERE id=?",
          JSON.stringify(actions), JSON.stringify(scopes), sealed, nonce(), key);
      } else {
        if (this.#first('SELECT id FROM connections WHERE provider=? AND account_id=?', provider, accountId)) throw failure('mailbox_already_connected', 409);
        this.#sql.exec("INSERT INTO connections VALUES (?,'mail',?,?,'active',1,?,?,?,?)",
          key, provider, accountId, JSON.stringify(actions), JSON.stringify(scopes), nonce(), sealed);
      }
      return this.get(key);
    });
  }

  updateActions(id, actions, expectedEpoch) {
    return this.#transact(() => {
      const current = this.assertEpoch(id, expectedEpoch);
      if (current.kind !== 'mail') throw failure('not_a_mail_connection');
      const next = validateActions(current.provider, actions);
      if (JSON.stringify(next) !== JSON.stringify(current.actions)) {
        this.#sql.exec('UPDATE connections SET actions=?,epoch=epoch+1 WHERE id=?', JSON.stringify(next), id);
      }
      return this.get(id);
    });
  }

  revoke(id, expectedEpoch) {
    return this.#transact(() => {
      const row = this.#row(id);
      if (expectedEpoch !== undefined) sameEpoch(row, expectedEpoch);
      if (row.status === 'active') {
        this.#sql.exec("UPDATE connections SET status='revoked',epoch=epoch+1,sealed=NULL,generation=?,actions='[]',scopes='[]' WHERE id=?", nonce(), id);
      }
      return this.get(id);
    });
  }

  async modelCredential(id, expectedEpoch) {
    this.assertEpoch(id, expectedEpoch);
    const row = this.#row(id);
    if (row.kind !== 'model') throw failure('not_a_model_connection');
    const secret = await this.#cipher.open(['model', row.provider, id], row.sealed);
    this.assertEpoch(id, expectedEpoch);
    const baseUrl = row.provider === compatibleProvider
      ? configuredModelBaseUrl(row.base_url, this.#env.MODEL_PROVIDER_HOSTS) : undefined;
    return { apiKey: secret.apiKey, ...(baseUrl ? { baseUrl } : {}) };
  }

  async credential(id, expectedEpoch) {
    this.assertEpoch(id, expectedEpoch);
    const row = this.#row(id);
    const secret = await this.#cipher.open([row.kind, row.provider, id], row.sealed);
    this.assertEpoch(id, expectedEpoch);
    if (row.kind === 'model') {
      if (row.provider === compatibleProvider) configuredModelBaseUrl(row.base_url, this.#env.MODEL_PROVIDER_HOSTS);
      return secret.apiKey;
    }
    if (secret.expiresAt > Date.now() + 60_000) return secret.accessToken;
    // Policy edits may share one grant. A replacement grant has its own flight.
    let flight = this.#refreshing.get(row.generation);
    if (!flight) {
      // Another reader can finish refreshing while this reader decrypts.
      if (this.#row(id).generation !== row.generation) return this.credential(id, expectedEpoch);
      flight = this.#refresh(row, secret).finally(() => this.#refreshing.delete(row.generation));
      this.#refreshing.set(row.generation, flight);
    }
    const accessToken = await flight;
    this.assertEpoch(id, expectedEpoch);
    return accessToken;
  }

  async #refresh(row, previous) {
    let result;
    try {
      result = await refreshGrant(row.provider, this.#env, previous, JSON.parse(row.scopes));
    } catch (error) {
      // A revoked grant observed at the provider invalidates local work, unless
      // the user has already finished authorizing a replacement.
      const current = this.#row(row.id);
      if (error.code === 'reauthorization_required' && current.generation === row.generation) this.revoke(row.id, current.epoch);
      throw error;
    }
    const sealed = await this.#cipher.seal(['mail', row.provider, row.id], result.secret);
    return this.#transact(() => {
      const current = this.#row(row.id);
      if (current.status !== 'active' || current.generation !== row.generation) throw failure('connection_changed', 409);
      const scopes = JSON.stringify(result.scopes);
      this.#sql.exec('UPDATE connections SET sealed=?,generation=?,scopes=?,epoch=epoch+? WHERE id=?',
        sealed, nonce(), scopes, scopes === current.scopes ? 0 : 1, row.id);
      return result.secret.accessToken;
    });
  }
}

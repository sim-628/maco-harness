import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from './support/storage.mjs';
import { ConnectionStore } from '../src/connections/index.mjs';
import { verifyOwner } from '../src/auth.mjs';

function storage(t) {
  const database = createStorage();
  t.after(() => database.close());
  return database;
}

const env = {
  CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'), GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-password', MICROSOFT_CLIENT_ID: 'ms-client',
  MICROSOFT_CLIENT_SECRET: 'ms-password', OAUTH_REDIRECT_URI: 'https://app.example/callback',
};
const gmail = 'https://www.googleapis.com/auth/gmail.';
const grant = (extras = {}) => ({
  access_token: 'secret-mail-access', token_type: 'Bearer', expires_in: 3600,
  refresh_token: 'secret-mail-refresh', scope: gmail + 'modify', ...extras,
});

test('mail OAuth reads the current client-secret binding and lookup failures preserve unused state and active grants', async t => {
  let value = 'client-secret-v1', unavailable = true, reads = 0;
  const config = { ...env, GOOGLE_CLIENT_SECRET: { async get() {
    reads++;
    if (unavailable) throw Error('upstream-private-value');
    return value;
  } } };
  const conn = new ConnectionStore(storage(t), config);
  const used = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('userinfo')) return Response.json({ sub: 'binding-account' });
    used.push(options.body.get('client_secret'));
    return Response.json(grant({ expires_in: options.body.get('grant_type') === 'authorization_code' ? 1 : 3600 }));
  });
  const { state } = await conn.beginOAuth({ provider: 'gmail', actions: ['archive'] });
  assert.equal(reads, 0, 'authorization URL construction does not fetch a client secret');
  await assert.rejects(conn.completeOAuth({ state, code: 'fixture-code' }), { code: 'oauth_configuration_missing', beforeDispatch: true });
  assert.deepEqual(used, []);
  unavailable = false;
  const connected = await conn.completeOAuth({ state, code: 'fixture-code' });
  assert.deepEqual(used, ['client-secret-v1']);
  unavailable = true;
  await assert.rejects(conn.credential(connected.id, connected.epoch), { code: 'oauth_configuration_missing' });
  assert.equal(conn.get(connected.id).status, 'active');
  value = 'client-secret-v2'; unavailable = false;
  assert.equal(await conn.credential(connected.id, connected.epoch), 'secret-mail-access');
  assert.deepEqual(used, ['client-secret-v1', 'client-secret-v2']);
});

test('mail OAuth rechecks session authority after a pending secret lookup before redeeming', async t => {
  let ready, release, allowed = true, calls = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const conn = new ConnectionStore(storage(t), { ...env, GOOGLE_CLIENT_SECRET: {
    async get() { ready(); await waiting; return 'fixture-secret'; },
  } });
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected provider I/O'); });
  const { state } = await conn.beginOAuth({ provider: 'gmail', actions: ['archive'] });
  const request = conn.completeOAuth({ state, code: 'fixture-code' }, { assertAuthorized() {
    if (!allowed) throw Object.assign(Error('session_revoked'), { code: 'session_revoked', status: 403 });
  } });
  const rejected = assert.rejects(request, { code: 'session_revoked' });
  await started;
  allowed = false; release();
  await rejected;
  assert.equal(calls, 0);
});

test('a revoked mailbox cannot refresh after waiting for a rotated client-secret binding', async t => {
  let ready, release, waiting = false, calls = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const conn = new ConnectionStore(storage(t), { ...env, GOOGLE_CLIENT_SECRET: {
    async get() { if (waiting) { ready(); await gate; } return 'fixture-secret'; },
  } });
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    return Response.json(url.includes('userinfo') ? { sub: 'bound-account' } : grant({ expires_in: 1 }));
  });
  const { state } = await conn.beginOAuth({ provider: 'gmail', actions: ['archive'] });
  const connected = await conn.completeOAuth({ state, code: 'fixture-code' });
  waiting = true;
  const rejected = assert.rejects(conn.credential(connected.id, connected.epoch), { code: 'connection_changed' });
  await started;
  conn.revoke(connected.id, connected.epoch);
  release(); await rejected;
  assert.equal(calls, 2);
});

test('model keys are sealed to one account, rotate by epoch and disappear from public projections', async t => {
  const left = storage(t), right = storage(t);
  const alice = new ConnectionStore(left, env), bob = new ConnectionStore(right, env);
  const key = 'secret-model-api-key';
  const m = await alice.putModel({ provider: 'anthropic', apiKey: key });
  assert.equal(await alice.credential(m.id, m.epoch), key);
  assert.doesNotMatch(JSON.stringify([alice.get(m.id), alice.list(), left.sql.exec('SELECT * FROM connections').toArray()]), /secret-model-api-key/);
  assert.throws(() => bob.get(m.id), { code: 'connection_not_found' });

  const encrypted = left.sql.exec('SELECT * FROM connections').toArray()[0];
  right.sql.exec('INSERT INTO connections VALUES (?,?,?,?,?,?,?,?,?,?)', ...Object.values(encrypted));
  await assert.rejects(bob.credential(m.id, m.epoch), { code: 'vault_decryption_failed' });
  await assert.rejects(alice.putModel({ id: m.id, expectedEpoch: 0, provider: m.provider, apiKey: 'new' }), { code: 'connection_changed' });
  const rotated = await alice.putModel({ id: m.id, expectedEpoch: 1, provider: m.provider, apiKey: 'new' });
  assert.equal(rotated.epoch, 2);
  await assert.rejects(alice.credential(m.id, 1), { code: 'connection_changed' });
  const pending = alice.credential(m.id, 2);
  alice.revoke(m.id, 2);
  await assert.rejects(pending, { code: 'connection_revoked' });
  assert.equal(left.sql.exec('SELECT sealed FROM connections').toArray()[0].sealed, null);
});

test('OAuth uses PKCE, single-use owner-bound transactions and stable provider account identity', async t => {
  const alice = new ConnectionStore(storage(t), env), bob = new ConnectionStore(storage(t), env);
  const start = await alice.beginOAuth({ provider: 'gmail', actions: ['modify'] });
  const url = new URL(start.authorizationUrl);
  assert.equal(url.searchParams.get('redirect_uri'), env.OAUTH_REDIRECT_URI);
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [gmail + 'modify', 'openid'].sort());
  const s256 = url.searchParams.get('code_challenge');
  let account = 'subject-1', calls = 0, verifier;
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    calls++;
    if (address === 'https://oauth2.googleapis.com/token') {
      verifier = options.body.get('code_verifier');
      assert.equal(options.body.get('redirect_uri'), env.OAUTH_REDIRECT_URI);
      return Response.json(grant());
    }
    assert.equal(address, 'https://openidconnect.googleapis.com/v1/userinfo');
    return Response.json({ sub: account });
  });
  const callback = { code: 'code', state: start.state };
  await assert.rejects(bob.completeOAuth(callback), { code: 'invalid_oauth_state' });
  const [a, b] = await Promise.allSettled([alice.completeOAuth(callback), alice.completeOAuth(callback)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.reason.code, 'invalid_oauth_state');
  assert.equal(calls, 2);
  assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'), s256);
  const connection = a.value;
  assert.ok(connection.actions.includes('add_label'));
  assert.ok(!connection.actions.some(action => ['trash', 'spam', 'permanent_delete', 'create_draft', 'forward', 'send'].includes(action)));
  assert.equal(connection.accountId, account);
  assert.deepEqual(connection.scopes, [gmail + 'modify']);

  async function relinkStart() {
    return alice.beginOAuth({ id: connection.id, expectedEpoch: connection.epoch, provider: 'gmail', actions: ['send'] });
  }
  account = 'subject-2';
  await assert.rejects(alice.completeOAuth({ state: (await relinkStart()).state, code: 'wrong-account' }), { code: 'mailbox_identity_changed' });
  assert.equal(alice.get(connection.id).epoch, connection.epoch);
  const abandoned = await relinkStart();
  alice.revoke(connection.id, connection.epoch);
  const before = calls;
  await assert.rejects(alice.completeOAuth({ state: abandoned.state, code: 'stale' }), { code: 'connection_changed' });
  assert.equal(calls, before);
});

test('concurrent refresh shares one request; scope loss invalidates the captured epoch', async t => {
  const conn = new ConnectionStore(storage(t), env);
  let refreshes = 0;
  let onRefresh;
  const started = new Promise(resolve => { onRefresh = resolve; });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('userinfo')) return Response.json({ sub: 'subject' });
    if (options.body.get('grant_type') === 'authorization_code') return Response.json(grant({ expires_in: 5 }));
    refreshes++;
    assert.equal(options.body.get('refresh_token'), 'secret-mail-refresh');
    onRefresh();
    await wait;
    return Response.json(grant({ scope: gmail + 'readonly', access_token: 'new-access', refresh_token: 'rotated' }));
  });
  const { state } = await conn.beginOAuth({ provider: 'gmail', actions: ['archive'] });
  const m = await conn.completeOAuth({ state, code: 'code' });
  const responses = Promise.allSettled(Array.from({ length: 8 }, () => conn.credential(m.id, m.epoch)));
  await started;
  release();
  for (const response of await responses) assert.equal(response.reason.code, 'connection_changed');
  assert.equal(refreshes, 1);
  assert.equal(conn.get(m.id).epoch, 2);
  assert.deepEqual(conn.get(m.id).scopes, [gmail + 'readonly']);
  assert.equal(await conn.credential(m.id, 2), 'new-access');
  assert.equal(refreshes, 1);
});

test('Outlook organization and send ask for independent grants, and revocation wins during refresh', async t => {
  const conn = new ConnectionStore(storage(t), env);
  const { state, authorizationUrl } = await conn.beginOAuth({ provider: 'outlook', actions: ['modify', 'write', 'move_to_trash', 'send'] });
  const scopes = new URL(authorizationUrl).searchParams.get('scope').split(' ');
  assert.deepEqual(scopes.sort(), ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'].sort());
  let markStarted, resolveRefresh;
  const pending = new Promise(resolve => { resolveRefresh = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('graph.microsoft.com/v1.0/me')) return Response.json({ id: 'graph-user' });
    if (options.body.get('grant_type') === 'refresh_token') { markStarted(); await pending; }
    return Response.json(grant({ expires_in: 3, scope: 'Mail.ReadWrite User.Read' }));
  });
  const m = await conn.completeOAuth({ state, code: 'code' });
  assert.ok(m.actions.includes('rename_folder') && !m.actions.includes('add_label'));
  assert.ok(m.actions.includes('trash') && m.actions.includes('update_draft'));
  for (const action of ['permanent_delete', 'delete_folder', 'spam']) {
    assert.throws(() => conn.updateActions(m.id, [action], m.epoch), { code: 'unsupported_mail_action' });
  }
  assert.ok(!m.scopes.includes('Mail.Send'));
  const read = conn.credential(m.id, m.epoch);
  await started;
  conn.revoke(m.id, m.epoch);
  resolveRefresh();
  await assert.rejects(read, { code: 'connection_changed' });
  assert.equal(conn.get(m.id).status, 'revoked');
});

test('Supabase verification checks signature, issuer, audience, expiration and role, and caches JWKS', async t => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const config = { SUPABASE_URL: 'https://project.example' };
  const issuer = config.SUPABASE_URL + '/auth/v1';
  const now = Math.floor(Date.now() / 1000);
  const defaults = { sub: 'alice', iss: issuer, aud: 'authenticated', role: 'authenticated', exp: now + 600 };
  let count = 0;
  t.mock.method(globalThis, 'fetch', async address => {
    count++;
    assert.equal(address, issuer + '/.well-known/jwks.json');
    return Response.json({ keys: [{ ...jwk, alg: 'ES256', kid: '1' }] });
  });
  async function signed(claims, header = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = encode({ alg: 'ES256', kid: '1', ...header }) + '.' + encode({ ...defaults, ...claims });
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(payload));
    return payload + '.' + Buffer.from(signature).toString('base64url');
  }
  const verify = token => verifyOwner(new Request('https://agent.example/?owner=bob', {
    headers: { Authorization: 'Bearer ' + token, 'X-Owner': 'bob' },
  }), config);
  const jwt = await signed({});
  assert.equal(await verify(jwt), 'alice');
  assert.equal(await verify(jwt), 'alice');
  assert.equal(count, 1);
  for (const claims of [{ exp: now }, { iss: 'https://wrong' }, { aud: 'other' }, { role: 'service_role' }, { nbf: now + 600 }]) {
    await assert.rejects(verify(await signed(claims)), { status: 401 });
  }
  await assert.rejects(verify(await signed({}, { alg: 'none' })), { status: 401 });
  const parts = jwt.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...defaults, sub: 'victim' })).toString('base64url');
  await assert.rejects(verify(parts.join('.')), { status: 401 });
});

test('compatible endpoints are connection-bound, allowlisted, versioned and independent of secret projections', async t => {
  const database = storage(t);
  const config = {...env, MODEL_PROVIDER_HOSTS:'api.vendor.com, inference.other.com'};
  const conn = new ConnectionStore(database, config);
  const initial = await conn.putModel({provider:'openai-compatible',apiKey:'private-compatible-key',baseUrl:'https://api.vendor.com/openai/v1/'});
  assert.equal(initial.baseUrl,'https://api.vendor.com/openai/v1');
  assert.equal(initial.provider,'openai-compatible');
  assert.deepEqual(await conn.modelCredential(initial.id,initial.epoch),{
    apiKey:'private-compatible-key',baseUrl:'https://api.vendor.com/openai/v1',
  });
  assert.doesNotMatch(JSON.stringify([conn.list(),conn.get(initial.id),database.sql.exec('SELECT * FROM connections').toArray()]),/private-compatible-key/);
  const rotated = await conn.putModel({id:initial.id,expectedEpoch:initial.epoch,provider:'openai-compatible',apiKey:'rotated-key'});
  assert.equal(rotated.epoch,2);
  assert.equal(rotated.baseUrl,initial.baseUrl);
  await assert.rejects(conn.modelCredential(initial.id,1),{code:'connection_changed'});
  const moved = await conn.putModel({id:initial.id,expectedEpoch:2,provider:'openai-compatible',apiKey:'new-endpoint-key',baseUrl:'https://inference.other.com/v1'});
  assert.equal(moved.epoch,3);
  assert.equal((await conn.modelCredential(initial.id,3)).baseUrl,'https://inference.other.com/v1');
  config.MODEL_PROVIDER_HOSTS = 'api.vendor.com';
  await assert.rejects(conn.modelCredential(initial.id,3),{code:'model_endpoint_not_allowed'});
  await assert.rejects(conn.credential(initial.id,3),{code:'model_endpoint_not_allowed'});
  config.MODEL_PROVIDER_HOSTS = 'inference.other.com';
  const pending = conn.modelCredential(initial.id,3);
  conn.revoke(initial.id,3);
  await assert.rejects(pending,{code:'connection_revoked'});
});

test('compatible endpoint validation rejects private literals, ambiguous URLs and untrusted DNS hosts', async t => {
  const config = {...env,MODEL_PROVIDER_HOSTS:'api.vendor.com'};
  const conn = new ConnectionStore(storage(t),config);
  for (const baseUrl of [
    'http://api.vendor.com/v1','https://127.0.0.1/v1','https://2130706433/v1','https://0x7f000001/v1',
    'https://10.0.0.1/v1','https://[::1]/v1','https://[2606:4700::1111]/v1','https://localhost/v1',
    'https://metadata.google.internal/v1','https://foo.local/v1','https://api.vendor.com:8443/v1',
    'https://user:password@api.vendor.com/v1','https://@api.vendor.com/v1',
    'https://api.vendor.com/v1?api-key=secret','https://api.vendor.com/v1#fragment',
    'https://api.vendor.com/v1/../internal','https://api.vendor.com/v1%2fextra','https://api.vendor.com/v1/chat/completions',
  ]) {
    await assert.rejects(conn.putModel({provider:'openai-compatible',apiKey:'test-key',baseUrl}),{code:'invalid_model_base_url'},baseUrl);
  }
  for (const baseUrl of ['https://api.vendor.com.attacker.com/v1','https://sub.api.vendor.com/v1','https://other-provider.com/v1']) {
    await assert.rejects(conn.putModel({provider:'openai-compatible',apiKey:'test-key',baseUrl}),{code:'model_endpoint_not_allowed'});
  }
  await assert.rejects(conn.putModel({provider:'openai',apiKey:'test-key',baseUrl:'https://api.vendor.com/v1'}),{code:'preset_endpoint_fixed'});
  config.MODEL_PROVIDER_HOSTS = '*.vendor.com';
  await assert.rejects(conn.putModel({provider:'openai-compatible',apiKey:'test-key',baseUrl:'https://api.vendor.com/v1'}),{code:'model_endpoint_not_allowed'});
  delete config.MODEL_PROVIDER_HOSTS;
  await assert.rejects(conn.putModel({provider:'openai-compatible',apiKey:'test-key',baseUrl:'https://api.vendor.com/v1'}),{code:'model_endpoint_not_allowed'});
  assert.equal(conn.list().length,0);
});

test('model endpoint migration preserves existing vault identity and preset credentials', async t => {
  const database = storage(t);
  const old = new ConnectionStore(database,env);
  const saved = await old.putModel({provider:'openai',apiKey:'preserved-key'});
  const vault = database.sql.exec('SELECT binding FROM vault_identity').one().binding;
  database.sql.exec('DROP TABLE model_endpoints');
  const migrated = new ConnectionStore(database,env);
  assert.equal(database.sql.exec('SELECT binding FROM vault_identity').one().binding,vault);
  assert.deepEqual(await migrated.modelCredential(saved.id,saved.epoch),{apiKey:'preserved-key'});
  assert.equal(migrated.get(saved.id).baseUrl,undefined);
});

test('configured aliases converge across devices and stay separate from OAuth credentials', async t => {
  const db = storage(t);
  const left = new ConnectionStore(db, env);
  const right = new ConnectionStore(db, env);
  const unrelated = new ConnectionStore(storage(t), env);
  t.mock.method(globalThis, 'fetch', async url => url.includes('userinfo')
    ? Response.json({sub:'aliases-account'}) : Response.json(grant()));
  const {state} = await left.beginOAuth({provider:'gmail'});
  const {id:mailboxId, epoch} = await left.completeOAuth({state,code:'fixture-code'});
  const sales = {id:crypto.randomUUID(),name:'Sales',address:'sales@example.test'};
  const team = {id:crypto.randomUUID(),name:'Team',address:'team@example.test'};
  const write = (connection, aliases) => connection.mergeConfiguredAliases({mailboxId,aliases});
  await Promise.all([write(left,[sales]),write(right,[team])]);
  const merged = await write(left,[{...sales,id:crypto.randomUUID(),address:'SALES@example.test'}]);
  assert.deepEqual(merged.aliases.sort((a,b)=>a.address.localeCompare(b.address)),[sales,team]);
  assert.deepEqual((await right.configuredAliases(mailboxId)).aliases.sort((a,b)=>a.address.localeCompare(b.address)),[sales,team]);
  assert.doesNotMatch(db.sql.exec('SELECT sealed FROM configured_mail_aliases').toArray()[0].sealed,/sales@example/);
  assert.equal(left.get(mailboxId).epoch,epoch);
  assert.equal(await left.credential(mailboxId,epoch),'secret-mail-access');
  await assert.rejects(unrelated.configuredAliases(mailboxId),{code:'connection_not_found'});
  await assert.rejects(write(left,[{...sales,address:'malformed'}]),{code:'invalid_mail_aliases'});
  left.fence();
  assert.equal((await right.configuredAliases(mailboxId)).aliases.length,2);
  const removal = await left.removeConfiguredAlias({mailboxId,address:sales.address,expectedAliasId:sales.id});
  assert.deepEqual(removal.aliases,[team]);
  assert.deepEqual((await write(right,[sales])).aliases,[team]);
  const replacement = {...sales,id:crypto.randomUUID()};
  const restore = {mailboxId,aliases:[replacement],restoring:removal.aliasSync.removed};
  assert.deepEqual((await right.mergeConfiguredAliases(restore)).aliases,[team,replacement]);
  await assert.rejects(left.removeConfiguredAlias({mailboxId,address:sales.address,expectedAliasId:sales.id}),{code:'connection_changed'});
  await left.removeConfiguredAlias({mailboxId,address:sales.address,expectedAliasId:replacement.id});
  assert.deepEqual((await right.mergeConfiguredAliases(restore)).aliases,[team]);
  const edited = {...team,name:'Finance',address:'finance@example.test'};
  const edit = () => left.editConfiguredAlias({mailboxId,previous:team,alias:edited});
  const changed = await edit();
  assert.deepEqual(changed.aliases,[edited]);
  assert.equal(changed.aliasSync.moved[team.address],edited.id);
  assert.equal((await edit()).aliasSync.version,changed.aliasSync.version);
  await assert.rejects(left.editConfiguredAlias({mailboxId,previous:team,alias:{...team,name:'Stale'}}),{code:'connection_changed'});
  assert.deepEqual((await write(right,[team])).aliases,[edited]);
  left.revoke(mailboxId,epoch,{removeAliases:true});
  assert.equal(db.sql.exec('SELECT COUNT(*) AS count FROM configured_mail_aliases').toArray()[0].count,0);
  await assert.rejects(right.configuredAliases(mailboxId),{code:'connection_revoked'});
});

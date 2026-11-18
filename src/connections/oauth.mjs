import { mailCapabilities, readOAuthScopes } from '../mail/policy.mjs';
import { withDeadline } from '../deadline.mjs';
import { failure } from './crypto.mjs';

const providers = {
  gmail: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET',
    identityScopes: ['openid'],
  },
  outlook: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    profile: 'https://graph.microsoft.com/v1.0/me?$select=id',
    clientId: 'MICROSOFT_CLIENT_ID', clientSecret: 'MICROSOFT_CLIENT_SECRET',
    identityScopes: ['User.Read', 'offline_access'],
  },
};

// Product grant for organizing an inbox. New action types require an explicit
// decision before they can join this grant.
const organize = [
  'mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'restore',
  'move_to_inbox', 'add_label', 'remove_label', 'create_label', 'rename_label',
  'move', 'create_folder', 'rename_folder', 'set_categories',
  'mark_spam', 'mark_not_spam', 'mark_important', 'mark_unimportant',
];

const write = ['create_draft', 'update_draft', 'add_draft_attachment', 'remove_draft_attachment'];
const productGrants = new Map([['modify', organize], ['write', write], ['move_to_trash', ['trash']]]);
// Destructive draft/label operations require their own explicit product grants.
// In particular, move_to_trash remains exactly ['trash'].
const eligibleActions = new Set([...organize, ...write, 'trash', 'send', 'reply', 'forward', 'delete_draft', 'delete_label']);

export function validateActions(provider, actions) {
  if (!Object.hasOwn(providers, provider)) throw failure('unknown_mail_provider');
  const supported = new Set(mailCapabilities({ provider, scopes: [] }).filter(cap => cap.supported).map(cap => cap.action));
  if (!Array.isArray(actions)) throw failure('unsupported_mail_action');
  const expanded = actions.flatMap(action => {
    if (productGrants.has(action)) return productGrants.get(action).filter(item => supported.has(item));
    if (!eligibleActions.has(action) || !supported.has(action)) throw failure('unsupported_mail_action');
    return [action];
  });
  return [...new Set(expanded)].sort();
}

function config(provider, env) {
  const spec = providers[provider];
  if (!spec || !env[spec.clientId] || !env[spec.clientSecret]) throw failure('oauth_configuration_missing', 503);
  return spec;
}

function redirectUri(env) {
  try {
    const url = new URL(env.OAUTH_REDIRECT_URI);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error();
    return env.OAUTH_REDIRECT_URI;
  } catch { throw failure('oauth_redirect_invalid', 503); }
}

export function authorization(provider, env, { actions, state, codeChallenge }) {
  const spec = config(provider, env);
  const capabilities = mailCapabilities({ provider, scopes: [] });
  const requirements = [readOAuthScopes(provider)];
  for (const action of actions) {
    const cap = capabilities.find(item => item.action === action && item.supported);
    if (!cap?.requiredScopes?.length) throw failure('unsupported_mail_action');
    requirements.push(cap.requiredScopes);
  }
  const permissions = new Set(requirements.map(alternatives => alternatives[0]));
  // For example, gmail.modify already includes read, whereas Graph Mail.Send does not.
  for (const candidate of [...permissions]) {
    if (requirements.every(group => group.some(scope => scope !== candidate && permissions.has(scope)))) permissions.delete(candidate);
  }
  const scopes = [...spec.identityScopes, ...permissions].sort();
  const redirect = redirectUri(env);
  const url = new URL(spec.authorize);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: env[spec.clientId], redirect_uri: redirect,
    code_challenge_method: 'S256', code_challenge: codeChallenge, state, scope: scopes.join(' '),
    ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : {}),
  }).toString();
  return { authorizationUrl: url.href, redirect, scopes };
}

async function remoteJSON(url, options) {
  try {
    return await withDeadline(15_000, null, async signal => {
      const response = await fetch(url, { ...options, redirect: 'manual', signal });
      const data = await response.json();
      if (!response.ok || !data || typeof data !== 'object') {
        if (data?.error === 'invalid_grant') throw failure('reauthorization_required', 403);
        throw failure('oauth_provider_unavailable', 503);
      }
      return data;
    });
  } catch (error) {
    if (error.code === 'reauthorization_required') throw error;
    throw failure('oauth_provider_unavailable', 503);
  }
}

function toGrant(data, priorScopes, previousRefresh) {
  if (typeof data.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(data.access_token)
    || String(data.token_type).toLowerCase() !== 'bearer'
    || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) throw failure('invalid_oauth_response', 502);
  const refreshToken = data.refresh_token ?? previousRefresh;
  if (typeof refreshToken !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(refreshToken)) throw failure('reauthorization_required', 403);
  // RFC 6749 permits omission when the authorized scope equals the requested scope.
  if (data.scope !== undefined && typeof data.scope !== 'string') throw failure('invalid_oauth_response', 502);
  const scopes = [...new Set(data.scope === undefined ? priorScopes : data.scope.trim().split(/\s+/).filter(Boolean))].sort();
  return { scopes, secret: { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 } };
}

async function token(provider, env, values) {
  const spec = config(provider, env);
  return remoteJSON(spec.token, {
    method: 'POST',
    body: new URLSearchParams({ client_id: env[spec.clientId], client_secret: env[spec.clientSecret], ...values }),
  });
}

export async function redeemCode(provider, env, code, txn) {
  const data = await token(provider, env, {
    grant_type: 'authorization_code', code, redirect_uri: txn.redirect, code_verifier: txn.verifier,
  });
  const result = toGrant(data, txn.scopes);
  const profile = await remoteJSON(providers[provider].profile, { headers: { Authorization: 'Bearer ' + result.secret.accessToken } });
  const accountId = provider === 'gmail' ? profile.sub : profile.id;
  if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 256) throw failure('oauth_account_unverified', 403);
  return { ...result, accountId };
}

export async function refreshGrant(provider, env, secret, scopes) {
  const data = await token(provider, env, { grant_type: 'refresh_token', refresh_token: secret.refreshToken });
  return toGrant(data, scopes, secret.refreshToken);
}

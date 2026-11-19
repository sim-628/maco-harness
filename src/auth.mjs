import { withDeadline } from './deadline.mjs';

// Supabase asymmetric access tokens share the project's JWKS across requests.
const issuers = new Map();
const formats = {
  ES256: { kty: 'EC', import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: { kty: 'RSA', import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: 'RSASSA-PKCS1-v1_5' },
};

function reject(status = 401) {
  const error = new Error(status === 401 ? 'A valid login is required' : 'Login verification unavailable');
  error.code = status === 401 ? 'unauthorized' : 'auth_unavailable';
  error.status = status;
  throw error;
}

function bytes(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) reject();
  return Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function decodeJSON(encoded) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(encoded)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  return value;
}

async function fetchKeys(issuer) {
  try {
    const { doc, ttl } = await withDeadline(8000, null, async signal => {
      const res = await fetch(issuer + '/.well-known/jwks.json', {redirect: 'manual', signal});
      if (!res.ok) {
        await res.body?.cancel();
        reject(503);
      }
      const cacheControl = res.headers.get('Cache-Control') || '';
      const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
      const age = Number(res.headers.get('Age') || 0);
      const seconds = maxAge === undefined ? 300 : Math.min(300, Math.max(0, Number(maxAge) - (Number.isFinite(age) ? age : 0)));
      return { doc: await res.json(), ttl: /(?:^|,)\s*(no-store|no-cache)\b/i.test(cacheControl) ? 0 : seconds * 1000 };
    });
    if (!Array.isArray(doc.keys)) reject(503);
    const keys = new Map();
    for (const jwk of doc.keys) {
      if (jwk?.use && jwk.use !== 'sig') continue;
      for (const [alg, fmt] of Object.entries(formats)) {
        if (fmt.kty !== jwk?.kty || (jwk.alg && jwk.alg !== alg) || !jwk.kid || jwk.d) continue;
        if (alg === 'ES256' && jwk.crv !== 'P-256') continue;
        const key = await crypto.subtle.importKey('jwk', jwk, fmt.import, false, ['verify']);
        keys.set(alg + '/' + jwk.kid, key);
      }
    }
    return { keys, ttl };
  } catch {
    reject(503);
  }
}

async function signingKey(issuer, alg, kid) {
  let cache = issuers.get(issuer);
  if (!cache) issuers.set(issuer, cache = { keys: new Map(), updatedAt: 0, ttl: 0 });
  const keyId = alg + '/' + kid;
  const age = Date.now() - cache.updatedAt;
  // Refresh on rotation, with a cooldown for unknown key IDs and one fetch in flight.
  if (age >= cache.ttl || (!cache.keys.has(keyId) && age > 30_000)) {
    cache.loading ??= fetchKeys(issuer).then(({ keys, ttl }) => {
      cache.keys = keys;
      cache.ttl = ttl;
      cache.updatedAt = Date.now();
    }).finally(() => { delete cache.loading; });
    await cache.loading;
  }
  return cache.keys.get(keyId) ?? reject();
}

export async function verifyIdentity(request, env) {
  if (!env.SUPABASE_URL) reject(503);
  let issuer;
  try {
    const origin = new URL(env.SUPABASE_URL);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) reject(503);
    issuer = origin.origin + '/auth/v1';
  } catch { reject(503); }
  const header = request.headers.get('Authorization') || '';
  const token = /^Bearer ([A-Za-z0-9._-]{1,16000})$/i.exec(header)?.[1];
  const parts = token?.split('.');
  if (parts?.length !== 3) reject();
  try {
    const { alg, kid, crit } = decodeJSON(parts[0]);
    if (!Object.hasOwn(formats, alg) || typeof kid !== 'string' || !kid || crit !== undefined) reject();
    const claims = decodeJSON(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audience.includes(env.JWT_AUDIENCE || 'authenticated')
      || claims.role !== 'authenticated' || typeof claims.sub !== 'string' || !claims.sub.trim()
      || !Number.isFinite(claims.exp) || claims.exp <= now
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))) reject();
    const key = await signingKey(issuer, alg, kid);
    const valid = await crypto.subtle.verify(formats[alg].verify, key, bytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!valid) reject();
    if (claims.session_id !== undefined && (typeof claims.session_id!=='string' || !/^[a-zA-Z0-9_.:@-]{1,128}$/.test(claims.session_id))) reject();
    if (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat<0 || claims.iat>now+30)) reject();
    const tokenHash = claims.session_id ? null : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),n=>n.toString(16).padStart(2,'0')).join('');
    return {owner:claims.sub,sessionId:claims.session_id || 'jwt_'+tokenHash,issuedAt:claims.iat || 0,expires:claims.exp};
  } catch (error) {
    if (error?.status === 503) throw error;
    reject();
  }
}

export async function verifyOwner(request,env) { return (await verifyIdentity(request,env)).owner }

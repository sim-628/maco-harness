import {withDeadline} from '../deadline.mjs';
import {fault} from './policy.mjs';

export const attachmentLimit = 512 * 1024;
export const bodyLimit = 48 * 1024;
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
const bases = {gmail:'https://gmail.googleapis.com/gmail/v1/users/me', outlook:'https://graph.microsoft.com/v1.0/me'};

export function validId(value, label = 'id') {
  // IDs become exactly one path segment. Percent escapes and dot segments have no place in provider IDs.
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f/#?%\\]/.test(value) || /^\.{1,2}$/.test(value)) throw fault('invalid_input', 'Invalid ' + label);
  return value;
}
export const segment = value => encodeURIComponent(validId(value));
export function string(value, label, max, header = false) {
  if (typeof value !== 'string' || encoder.encode(value).length > max || (header && /[\x00-\x1f\x7f]/.test(value))) throw fault('invalid_input', 'Invalid ' + label);
  return value;
}
export function keys(object, allowed) {
  if (!object || Array.isArray(object) || typeof object !== 'object' || Object.keys(object).some(key => !allowed.includes(key))) throw fault('invalid_input');
}
export function b64(bytes) {
  let s = '';
  for (let i=0;i<bytes.length;i+=8192) s += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(s);
}
export const base64url = bytes => b64(bytes).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
export function unbase64(s, max) {
  if (typeof s !== 'string' || s.length > 4*Math.ceil(max/3)+2) throw fault('content_too_large');
  let data;
  try { data = atob(s.replace(/-/g,'+').replace(/_/g,'/')); } catch { throw fault('invalid_provider_response'); }
  if (data.length > max) throw fault('content_too_large');
  return Uint8Array.from(data, ch => ch.charCodeAt(0));
}
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
}

async function boundedBody(response, max, binary=false) {
  if (!response.body) return null;
  if (Number(response.headers.get('content-length')) > max) {
    await response.body.cancel();
    throw fault('content_too_large');
  }
  const reader = response.body.getReader();
  let bytes = new Uint8Array(Math.min(max,4096));
  let size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    const end=size+value.byteLength;
    if (end>max) { await reader.cancel(); throw fault('content_too_large'); }
    if (end>bytes.length) {
      const grown=new Uint8Array(Math.min(max,Math.max(end,bytes.length*2)));
      grown.set(bytes.subarray(0,size));
      bytes=grown;
    }
    bytes.set(value,size);
    size=end;
  }
  if (binary) return bytes.slice(0,size);
  if (!size) return null;
  try { return JSON.parse(decoder.decode(bytes.subarray(0,size))); } catch { throw fault('invalid_provider_response'); }
}

// Only adapter-constructed relative endpoints ever receive a credential. A redirect may change origin.
export async function request(ctx, path, {method='GET', query, body, contentType='application/json', max=2*1024*1024, headers={},binary=false} = {}) {
  const {credential,fetchImpl=fetch} = ctx;
  if (!bases[credential?.provider] || !credential?.accessToken) throw fault('reauthorization_required');
  const url = new URL(bases[credential.provider] + (path ? '/' + path : ''));
  for (const [key,val] of Object.entries(query || {})) if (val != null) url.searchParams.set(key,String(val));
  const auth = {Authorization:'Bearer '+credential.accessToken,...headers};
  if (credential.provider === 'outlook') auth.Prefer = 'IdType="ImmutableId", outlook.body-content-type="text"';
  if (body !== undefined) auth['Content-Type'] = contentType;
  const write = method !== 'GET';
  if (ctx.signal?.aborted) throw fault('request_cancelled');
  return withDeadline(20_000, ctx.signal, async signal => {
    const init = {
      method, headers:auth, redirect:'manual', signal,
      body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
    };
    // There is no yield between epoch revalidation and dispatch.
    if (write) ctx.beforeWrite?.();
    else ctx.assertCurrent?.();
    let response;
    try { response = await fetchImpl(url.toString(), init); }
    catch { throw fault(write ? 'submission_unknown' : 'provider_unavailable'); }
    const result=await readResponse(response,max,write,binary);
    if (!write) ctx.assertCurrent?.();
    return result;
  });
}

async function readResponse(response,max,write,binary) {
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    let code = 'provider_rejected';
    if (response.status === 408 || response.status >= 500) code = write ? 'submission_unknown' : 'provider_unavailable';
    else if (response.status === 401) code = 'reauthorization_required';
    else if (response.status === 403) code = 'scope_required';
    else if (response.status === 404) code = 'not_found';
    else if ([409,412].includes(response.status)) code = 'version_conflict';
    else if (response.status === 429) code = 'rate_limited';
    const error = Object.assign(fault(code), {httpStatus:response.status});
      const retry = response.headers.get('Retry-After');
      if (code === 'rate_limited' && retry) {
        const ms = /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
        if (Number.isSafeInteger(ms) && ms>0 && ms<=7*86400000) error.retryAfterMs = ms;
      }
      throw error;
  }
  try { return {status:response.status,data:await boundedBody(response,max,binary)}; }
  catch (error) { throw write ? fault('submission_unknown') : error; }
}

import {requireThat} from './protocol.mjs'

// Native clients send no Origin. Browser access is allowed only from the
// Worker itself or an operator-configured exact origin, including its port.
export function browserOrigin(request, env) {
  const origin = request.headers.get('Origin')
  if (!origin) return null
  const own = new URL(request.url).origin
  const allowed = new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean))
  let parsed
  try { parsed = new URL(origin) } catch { requireThat(false,'origin_not_allowed',403) }
  requireThat(parsed.origin === origin && ['http:','https:'].includes(parsed.protocol)
    && (origin === own || allowed.has(origin)), 'origin_not_allowed',403)
  return origin
}

export function preflight(request, origin) {
  requireThat(origin, 'origin_required',403)
  const method = request.headers.get('Access-Control-Request-Method')
  requireThat(['GET','POST','PUT'].includes(method),'method_not_allowed',405)
  const requested = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
  requireThat(requested.every(h => ['authorization','content-type','idempotency-key','x-content-sha256'].includes(h)), 'cors_header_not_allowed',403)
  return new Response(null,{status:204,headers:{
    'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers':'Authorization, Content-Type, Idempotency-Key, X-Content-SHA256',
    'Access-Control-Max-Age':'600',
    'Vary':'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  }})
}

export function cors(response, origin) {
  // The origin was validated before the upgrade. Preserve the live socket.
  if (!origin || response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin',origin)
  headers.append('Vary','Origin')
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers})
}

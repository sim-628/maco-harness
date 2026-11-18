export const PROTOCOL_VERSION = 1

export class ApiError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

export function requireThat(condition, code, status = 400) {
  if (!condition) throw new ApiError(status, code)
}

export function identifier(value, field) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_.:@-]{1,128}$/.test(value), 'invalid_' + field)
  return value
}

export function messageText(value) {
  requireThat(typeof value === 'string' && value.trim() && value.length <= 16000, 'invalid_message')
  return value
}

export function checkedVersion(expected, actual) {
  requireThat(Number.isSafeInteger(expected) && expected === actual, 'stale_version', 409)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
}

export function errorCode(error, fallback = 'internal_error') {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : fallback
}

import { ApiError } from './protocol.mjs'

const encoder = new TextEncoder()

// A native Secrets Store binding is a capability, not an arbitrary name that
// the caller can look up. Only deployment-provided env values reach this helper.
export function hasSecret(source) {
  if (typeof source === 'string') return source.trim().length > 0
  try { return source !== null && typeof source === 'object' && typeof source.get === 'function' }
  catch { return false }
}

function unavailable(code) {
  // Callers with an external-write ledger can distinguish this from a request
  // whose outcome is unknown. Never expose a binding's original error or value.
  return Object.assign(new ApiError(503, code), { beforeDispatch: true })
}

export async function readSecret(source, {
  signal, code = 'secret_unavailable', maxBytes = 65536, timeoutMs = 5000,
} = {}) {
  const validate = value => {
    if (typeof value !== 'string' || !value.trim() || encoder.encode(value).byteLength > maxBytes) throw unavailable(code)
    return value
  }
  if (signal?.aborted || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !hasSecret(source)) throw unavailable(code)
  if (typeof source === 'string') return validate(source)

  // get() has no AbortSignal argument. Bound our wait and discard a late result;
  // attach both handlers so a rejection after timeout cannot become unhandled.
  // Do not cache successful values: the next use should consult the binding.
  return new Promise((resolve, reject) => {
    let done = false, timer
    const finish = (value, failed = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (failed) return reject(unavailable(code))
      try { resolve(validate(value)) } catch { reject(unavailable(code)) }
    }
    const aborted = () => finish(undefined, true)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) return aborted()
    timer = setTimeout(aborted, timeoutMs)
    Promise.resolve().then(() => done ? undefined : source.get()).then(value => finish(value), () => finish(undefined, true))
  })
}

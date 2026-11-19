import { withDeadline } from '../deadline.mjs'
import { hasSecret, readSecret } from '../secrets.mjs'

// Deliberately fixed: the deployment credential must never follow a model- or
// user-supplied URL. Agents Sessions is a different protocol from Responses.
const origin = 'https://api.openai.com/v1'
const encoder = new TextEncoder()
export const remoteId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
export const hostedError = (code, fields = {}) => Object.assign(new Error(code), {code, ...fields})
const id = value => {
  if (!remoteId(value)) throw hostedError('hosted_invalid_reference')
  return value
}

async function readBytes(response, maxBytes, signal) {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel()
    throw hostedError('hosted_response_too_large')
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks = []
  let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort',abort,{once:true})
  try {
    for (;;) {
      signal.throwIfAborted()
      const {done,value} = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw hostedError('hosted_response_too_large')
      chunks.push(value)
    }
  } finally { signal.removeEventListener('abort',abort); await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of chunks) { bytes.set(part,offset); offset += part.byteLength }
  return bytes
}

export class OpenAIHostedClient {
  constructor(env, {fetcher = fetch, timeoutMS = 20000} = {}) {
    Object.assign(this,{env,fetcher,timeoutMS})
  }

  async request(path, {method = 'GET',body,form,signal,missingOK = false,ack = false,
    key,binary = false,maxBytes = 4*1024*1024,beforeDispatch,onDispatch} = {}) {
    if (!hasSecret(this.env.OPENAI_AGENTS_API_KEY)) {
      throw hostedError('hosted_not_configured',{status:503,beforeDispatch:true})
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    if (encoded && encoder.encode(encoded).length > 4*1024*1024-8192) throw hostedError('hosted_input_too_large')
    if (key !== undefined && !/^[A-Za-z0-9:_-]{1,200}$/.test(key)) throw hostedError('hosted_invalid_idempotency_key')
    let dispatched = false
    try {
      return await withDeadline(this.timeoutMS,signal,async deadline => {
        // Resolve for each provider request, including alarms and cleanup. A
        // binding must not turn into a long-lived copy of an operator's key.
        const credential = await readSecret(this.env.OPENAI_AGENTS_API_KEY,{
          signal:deadline,code:'hosted_secret_unavailable',maxBytes:16384,
        })
        if (!credential.trim() || /[\r\n]/.test(credential)) throw hostedError('hosted_not_configured',{status:503})
        // Binding lookup is asynchronous. Recheck the execution before making
        // the dispatch receipt durable and starting external I/O.
        await beforeDispatch?.()
        deadline.throwIfAborted()
        onDispatch?.()
        dispatched = true
        const response = await this.fetcher(origin+path,{
          method,redirect:'manual',signal:deadline,
          headers:{Authorization:'Bearer '+credential.trim(),'OpenAI-Beta':'agents=v1',
            ...(encoded ? {'Content-Type':'application/json'} : {}),...(key ? {'Idempotency-Key':key} : {})},
          body:form ?? encoded,
        })
        if (response.status === 404 && missingOK) { await response.body?.cancel(); return null }
        if (!response.ok) {
          // Do not persist upstream messages: they may echo input or credentials.
          await response.body?.cancel()
          const seconds = Number(response.headers.get('retry-after'))
          const retryAfterMS = Number.isFinite(seconds) && seconds >= 0 ? Math.min(60000,seconds*1000) : undefined
          const code = [401,403].includes(response.status) ? 'hosted_not_configured'
            : response.status === 429 ? 'hosted_rate_limited'
              : response.status >= 500 || response.status === 408 ? 'hosted_unavailable' : 'hosted_provider_rejected'
          throw hostedError(code,{upstreamStatus:response.status,retryAfterMS})
        }
        if (ack || response.status === 204) { await response.body?.cancel(); return null }
        const bytes = await readBytes(response,maxBytes,deadline)
        if (binary) return bytes
        try {
          const data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
          return data
        } catch { throw hostedError('hosted_invalid_response') }
      })
    } catch (error) {
      const safe = typeof error?.code === 'string' && error.code.startsWith('hosted_') ? error
        : hostedError(signal?.aborted ? 'hosted_request_aborted' : 'hosted_unavailable')
      if (!dispatched) safe.beforeDispatch = true
      throw safe
    }
  }

  page(path, {after,order = 'asc',limit = 100,signal,beforeDispatch} = {}) {
    if (!['asc','desc'].includes(order) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw hostedError('hosted_invalid_page')
    const query = new URLSearchParams({order,limit:String(limit)})
    if (after) query.set('after',id(after))
    return this.request(path+'?'+query,{signal,beforeDispatch})
  }
  create(body,signal,{beforeDispatch,onDispatch} = {}) {
    return this.request('/agents/sessions',{method:'POST',body,signal,beforeDispatch,onDispatch})
  }
  retrieve(sessionId,signal,{beforeDispatch} = {}) { return this.request('/agents/sessions/'+id(sessionId),{signal,missingOK:true,beforeDispatch}) }
  list(options) { return this.page('/agents/sessions',options) }
  turns(sessionId,options) { return this.page('/agents/sessions/'+id(sessionId)+'/turns',options) }
  items(sessionId,turnId,options) { return this.page('/agents/sessions/'+id(sessionId)+'/turns/'+id(turnId)+'/items',options) }
  cancel(sessionId,key,signal) {
    return this.request('/agents/sessions/'+id(sessionId)+'/events',{
      method:'POST',body:{events:[{type:'agent.session.input.cancel'}]},key,signal,ack:true,
    })
  }
  remove(sessionId,signal) { return this.request('/agents/sessions/'+id(sessionId),{method:'DELETE',signal,missingOK:true,ack:true}) }
  upload(bytes,name,signal,{beforeDispatch,onDispatch} = {}) {
    const form = new FormData()
    form.set('purpose','user_data')
    form.set('expires_after[anchor]','created_at')
    form.set('expires_after[seconds]','3600')
    form.set('file',new Blob([bytes]),name)
    return this.request('/files',{method:'POST',form,signal,beforeDispatch,onDispatch})
  }
  files(options) {
    const query = new URLSearchParams({purpose:'user_data',order:'desc',limit:'100'})
    if (options?.after) query.set('after',id(options.after))
    return this.request('/files?'+query,{signal:options?.signal})
  }
  removeFile(fileId,signal) { return this.request('/files/'+id(fileId),{method:'DELETE',signal,missingOK:true,ack:true}) }

  // Official Agents Sessions Artifacts API; outputs are immutable and bound to
  // a completed turn. Never download an arbitrary URL found in model output.
  // https://developers.openai.com/api/docs/guides/agents-api/environments/files
  artifacts(sessionId,options) { return this.page('/agents/sessions/'+id(sessionId)+'/artifacts',options) }
  artifactBytes(sessionId,artifactId,maxBytes,signal,{beforeDispatch} = {}) {
    return this.request('/agents/sessions/'+id(sessionId)+'/artifacts/'+id(artifactId)+'/content',
      {signal,binary:true,maxBytes,beforeDispatch})
  }
}

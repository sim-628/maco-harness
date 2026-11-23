import {withDeadline} from './deadline.mjs'

const endpoint = 'https://maco-agent-cloud.zhengpushen.workers.dev/v1/chat'
const actions = new Set(['scheduledMailCreate','scheduledMailList','scheduledMailCancel','scheduledMailUpdate'])
const maxBodyBytes = 16 * 1024 * 1024

function failure(code,status) {
  return Response.json({error:{code}},{status,headers:{'Cache-Control':'no-store'}})
}

async function readBody(request,signal) {
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8',{fatal:true})
  const cancel = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener('abort',cancel,{once:true})
  let size = 0, body = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodyBytes) return failure('BODY_TOO_LARGE',413)
      body += decoder.decode(value,{stream:true})
    }
    signal.throwIfAborted()
    body += decoder.decode()
    const data = JSON.parse(body)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('INVALID_JSON',400)
    if (!actions.has(data.action)) return failure('INVALID_ACTION',400)
    return body
  } catch {
    return signal.aborted ? failure('REQUEST_TIMEOUT',408) : failure('INVALID_JSON',400)
  } finally {
    signal.removeEventListener('abort',cancel)
    cancel()
  }
}

export async function forwardScheduledMail(request,upstream,assertAuthorized) {
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED',405)
  const authorization = request.headers.get('Authorization')
  if (!authorization) return failure('UNAUTHORIZED',401)
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return failure('EXPECTED_JSON',415)
  if (!request.body) return failure('INVALID_JSON',400)
  if (Number(request.headers.get('Content-Length')) > maxBodyBytes) return failure('BODY_TOO_LARGE',413)

  const body = await withDeadline(20000,request.signal,signal => readBody(request,signal))
  if (body instanceof Response) return body
  // Recheck the Harness session after reading the body. Cloud then validates
  // the same bearer token before accessing the shared account queue.
  assertAuthorized()
  if (!upstream?.fetch) return failure('SCHEDULED_MAIL_UNAVAILABLE',503)
  try {
    const response = await withDeadline(30000,request.signal,signal => upstream.fetch(new Request(endpoint,{
      method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body,redirect:'manual',signal,
    })))
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return failure('SCHEDULED_MAIL_UNAVAILABLE',502)
    }
    return response
  } catch {
    return failure('SCHEDULED_MAIL_UNAVAILABLE',503)
  }
}

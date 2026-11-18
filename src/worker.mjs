import { DurableObject } from 'cloudflare:workers'
import { AgentService } from './service.mjs'
import { verifyOwner } from './auth.mjs'
import { ApiError, errorCode, requireThat } from './protocol.mjs'
import { operationView } from './store.mjs'
import { browserOrigin, preflight, cors } from './http.mjs'

const json = (value,status = 200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}})
function fail(error) {
  const code = errorCode(error)
  let status = error.status
  if (!status) {
    if (['scope_required','action_forbidden','reauthorization_required'].includes(code)) status = 403
    else if (code === 'rate_limited') status = 429
    else if (['not_found','message_not_found','message_deleted'].includes(code)) status = 404
    else if (['version_conflict','index_cursor_changed'].includes(code)) status = 409
    else if (code === 'provider_unavailable') status = 503
    else status = code === 'internal_error' ? 500 : 422
  }
  return json({error:code},status)
}
function numberParam(url,name,fallback) {
  const raw = url.searchParams.get(name)
  const value = raw === null ? fallback : Number(raw)
  requireThat(Number.isSafeInteger(value) && value >= 0,'invalid_' + name)
  return value
}
async function payload(request) {
  requireThat(request.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json','expected_json',415)
  const reader = request.body?.getReader()
  requireThat(reader,'missing_body')
  const decoder = new TextDecoder('utf-8',{fatal:true})
  let size = 0, text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      requireThat(size <= 256*1024,'body_too_large',413)
      text += decoder.decode(chunk.value,{stream:true})
    }
    const value = JSON.parse(text + decoder.decode())
    requireThat(value && typeof value === 'object' && !Array.isArray(value),'invalid_json')
    return value
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error instanceof ApiError ? error : new ApiError(400,'invalid_json')
  }
}

export default {
  async fetch(request,env) {
    let origin
    try {
      const url = new URL(request.url)
      origin = browserOrigin(request,env)
      if (request.method === 'OPTIONS') return preflight(request,origin)
      if (url.pathname === '/health' && request.method === 'GET') return cors(json({service:'maco-harness',protocolVersion:1}),origin)
      requireThat(url.pathname.startsWith('/v1/'),'not_found',404)
      const headers = new Headers(request.headers)
      if (url.pathname === '/v1/socket' && !headers.has('Authorization')) {
        const offered = (headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim())
        const token = offered.find(s => s.startsWith('bearer.'))
        if (offered.includes('maco.v1') && token) headers.set('Authorization','Bearer ' + token.slice(7))
      }
      const owner = await verifyOwner({headers},env)
      const claims = headers.get('Authorization').split('.')[1].replace(/-/g,'+').replace(/_/g,'/')
      headers.set('X-Maco-Expires',String(JSON.parse(atob(claims)).exp))
      headers.delete('Authorization')
      headers.delete('Cookie')
      const protocols = (headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim())
      headers.delete('Sec-WebSocket-Protocol')
      if (protocols.includes('maco.v1')) headers.set('Sec-WebSocket-Protocol','maco.v1')
      return cors(await env.AGENTS.getByName(owner).fetch(new Request(request,{headers})),origin)
    } catch (error) {
      const response = fail(error)
      if (response.status >= 500) console.error(JSON.stringify({event:'request_failed',code:errorCode(error),status:response.status}))
      return cors(response,origin)
    }
  }
}

export class MacoAgent extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env)
    this.service = new AgentService(ctx,env,{emit:event => this.broadcast(event)})
  }
  async alarm() { await this.service.host.alarm() }

  replay(after,limit = 128) {
    const store = this.service.store
    const started = Date.now()
    const head = store.cursor()
    requireThat(after <= head,'invalid_cursor',409)
    const events = store.events(after,limit)
    const committedCursor = events.at(-1)?.seq ?? after
    store.timing('cursor_replay',Date.now()-started)
    return {protocolVersion:1,events,committedCursor,hasMore:committedCursor < head}
  }
  subscribe(request,url) {
    requireThat(request.headers.get('Upgrade')?.toLowerCase() === 'websocket','websocket_upgrade_required',426)
    const after = numberParam(url,'after',0)
    const page = this.replay(after)
    requireThat(!page.hasMore,'replay_over_http_first',409)
    const [client,server] = Object.values(new WebSocketPair())
    server.serializeAttachment({acked:after,sent:after,expires:Number(request.headers.get('X-Maco-Expires'))})
    this.ctx.acceptWebSocket(server)
    for (const event of page.events) this.deliver(server,event)
    const headers = request.headers.has('Sec-WebSocket-Protocol') ? {'Sec-WebSocket-Protocol':'maco.v1'} : {}
    return new Response(null,{status:101,webSocket:client,headers})
  }
  deliver(socket,event) {
    const state = socket.deserializeAttachment()
    if (Date.now() >= state.expires*1000) { socket.close(1008,'refresh login'); return }
    if (event.seq - state.acked > 128) { socket.close(1013,'resume via events'); return }
    socket.send(JSON.stringify(event))
    state.sent = event.seq
    socket.serializeAttachment(state)
  }
  broadcast(event) {
    const started = Date.now()
    for (const socket of this.ctx.getWebSockets()) {
      try { this.deliver(socket,event) } catch { try { socket.close(1011,'resume via events') } catch {} }
    }
    if (event.type === 'message.delta') this.service.store.timing('delta_broadcast',Date.now()-started)
  }
  webSocketMessage(socket,raw) {
    try {
      requireThat(typeof raw === 'string' && raw.length < 256,'invalid_ack')
      const ack = JSON.parse(raw)
      const state = socket.deserializeAttachment()
      requireThat(ack.type === 'ack' && Number.isSafeInteger(ack.seq) && ack.seq >= state.acked &&
        ack.seq <= state.sent && Date.now() < state.expires*1000,'invalid_ack')
      socket.serializeAttachment({...state,acked:ack.seq})
    } catch { socket.close(1008,'invalid acknowledgement or expired login') }
  }
  webSocketClose(socket,code,reason) {
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code,reason) } catch {}
  }
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const service = this.service
    const vault = service.connections
    try {
      if (request.method === 'GET') {
        if (path === '/v1/socket') return this.subscribe(request,url)
        if (path === '/v1/events') return json(this.replay(numberParam(url,'after',0)))
        if (path === '/v1/metrics') return json({timings:service.store.timings()})
        if (path === '/v1/snapshot') return json(service.store.snapshot())
        if (path === '/v1/tasks') return json(service.store.taskPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER),url.searchParams.get('active')==='1'))
        if (path === '/v1/pending') return json(service.store.pendingPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER)))
        if (path === '/v1/operations') return json(service.store.operationPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER)))
        if (path === '/v1/connections') return json({connections:vault.list()})
        if (path === '/v1/memory') return json(service.memory.list({includeDeleted:url.searchParams.get('deleted')==='1',limit:numberParam(url,'limit',200)}))
        if (path === '/v1/memory/context') return json(service.memory.context(url.searchParams.get('taskId') || '',{query:url.searchParams.get('query') || undefined}))
        if (path === '/v1/mail/index') {
          const mailboxId = url.searchParams.get('mailboxId')
          service.mail.metadata(mailboxId)
          return json({index:service.index.syncState(mailboxId)})
        }
        if (path === '/v1/capabilities') return json(service.capabilities(url.searchParams.get('connectionId'),url.searchParams.get('model')))
        const task = /^\/v1\/tasks\/([\w-]+)$/.exec(path)
        if (task) return json(service.history(task[1],numberParam(url,'before',Number.MAX_SAFE_INTEGER)))
        const op = /^\/v1\/operations\/([\w:.-]+)$/.exec(path)
        if (op) {
          const operation = service.store.getOp(op[1])
          requireThat(operation,'operation_not_found',404)
          return json(operationView(operation))
        }
      }
      if (request.method === 'POST') {
        const body = await payload(request)
        if (path === '/v1/commands') return json(await service.command(body),202)
        if (path === '/v1/mail/read') return json(await service.read(body))
        if (path === '/v1/history/search') return json(service.queryHistory('history_search',body))
        if (path === '/v1/history/read') return json(service.queryHistory('history_read',body))
        let connection
        switch (path) {
          case '/v1/connections/model': connection = await vault.putModel(body); break
          case '/v1/connections/oauth/start': return json(await vault.beginOAuth(body))
          case '/v1/connections/oauth/complete': connection = await vault.completeOAuth(body); break
          case '/v1/connections/actions': connection = await vault.updateActions(body.id,body.actions,body.expectedEpoch); break
          case '/v1/connections/revoke':
            connection = await vault.revoke(body.id,body.expectedEpoch)
            if (connection.kind === 'mail') service.index.clearMailbox(connection.id)
            break
          default: throw new ApiError(404,'not_found')
        }
        service.store.event('connection.updated',{connection})
        return json(connection)
      }
      throw new ApiError(404,'not_found')
    } catch (error) { return fail(error) }
  }
}

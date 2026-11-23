import { DurableObject } from 'cloudflare:workers'
import { AgentService } from './service.mjs'
import { verifyIdentity } from './auth.mjs'
import { ApiError, errorCode, requireThat } from './protocol.mjs'
import { operationView } from './store.mjs'
import { browserOrigin, preflight, cors } from './http.mjs'
import { forwardScheduledMail } from './scheduled-mail-compat.mjs'
import { NotificationRegistryService, createRegistryPort, graphValidationResponse, verifyGmailPush,
  parseGraphPush, verifyGraphItem } from './notifications/index.mjs'

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

async function notificationsWebhook(request,env) {
  const graph=new URL(request.url).pathname==='/webhooks/graph'
  if (graph) {const validation=graphValidationResponse(request);if (validation) return validation}
  const notifications=graph ? await parseGraphPush(request) : [await verifyGmailPush(request,env)]
  const registry=createRegistryPort(env),lookups=new Map(),deliveries=[]
  let ignored=0,invalid=0
  // Validate every destination before dispatching. Bounded fan-out prevents a
  // provider batch from creating an unbounded number of account requests.
  for (const notification of notifications) {
    const key=graph ? notification.subscriptionId : notification.email
    if (!lookups.has(key)) lookups.set(key,await registry.lookup(notification))
    const {routes}=lookups.get(key)
    if (!routes.length) ignored++
    for (const route of routes) {
      if (graph && !await verifyGraphItem(notification,route)) {invalid++;ignored++;continue}
      deliveries.push({route,notification})
      requireThat(deliveries.length<=256,'notification_batch_fanout_exceeded',503)
    }
  }
  requireThat(deliveries.length>0 || !invalid,'notification_push_unauthorized',401)
  let accepted=0
  for (let index=0;index<deliveries.length;index+=8) {
    const results=await Promise.all(deliveries.slice(index,index+8).map(async body=>{
      const account=env.AGENTS.get(env.AGENTS.idFromString(body.route.ownerId))
      const response=await account.fetch(new Request('https://account.internal/internal/notifications/ingest',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}))
      await response.body?.cancel()
      if (response.ok) return true
      if ([401,403,404,409,410].includes(response.status)) return false
      throw new ApiError(503,'notification_ingest_unavailable')
    }))
    accepted+=results.filter(Boolean).length;ignored+=results.filter(value=>!value).length
  }
  return json({accepted,ignored},202)
}

export default {
  async fetch(request,env) {
    let origin
    try {
      const url = new URL(request.url)
      if (['/webhooks/gmail','/webhooks/graph'].includes(url.pathname)) return await notificationsWebhook(request,env)
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
      const identity = await verifyIdentity({headers},env)
      headers.set('X-Maco-Expires',String(identity.expires))
      headers.set('X-Maco-Session',identity.sessionId)
      headers.set('X-Maco-Issued-At',String(identity.issuedAt))
      // Scheduled mail shares the Maco Cloud queue and needs the original JWT
      // for its independent authorization. Other routes use internal identity.
      if (url.pathname !== '/v1/chat' || request.method !== 'POST') headers.delete('Authorization')
      headers.delete('Cookie')
      const protocols = (headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim())
      headers.delete('Sec-WebSocket-Protocol')
      if (protocols.includes('maco.v1')) headers.set('Sec-WebSocket-Protocol','maco.v1')
      return cors(await env.AGENTS.getByName(identity.owner).fetch(new Request(request,{headers})),origin)
    } catch (error) {
      const response = fail(error)
      if (response.status >= 500) console.error(JSON.stringify({event:'request_failed',code:errorCode(error),status:response.status}))
      return cors(response,origin)
    }
  }
}

export class NotificationRegistry extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.registry=new NotificationRegistryService(ctx.storage,env)}
  fetch(request) {return this.registry.fetch(request)}
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
    server.serializeAttachment({acked:after,sent:after,expires:Number(request.headers.get('X-Maco-Expires')),sessionId:request.headers.get('X-Maco-Session')})
    this.ctx.acceptWebSocket(server)
    for (const event of page.events) this.deliver(server,event)
    const headers = request.headers.has('Sec-WebSocket-Protocol') ? {'Sec-WebSocket-Protocol':'maco.v1'} : {}
    return new Response(null,{status:101,webSocket:client,headers})
  }
  deliver(socket,event) {
    const state = socket.deserializeAttachment()
    try { this.service.assertAvailable();this.service.sessions.assertActive(state.sessionId) } catch { socket.close(1008,'authorization changed');return }
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
      this.service.assertAvailable()
      const ack = JSON.parse(raw)
      const state = socket.deserializeAttachment()
      this.service.sessions.assertActive(state.sessionId)
      requireThat(ack.type === 'ack' && Number.isSafeInteger(ack.seq) && ack.seq >= state.acked &&
        ack.seq <= state.sent && Date.now() < state.expires*1000,'invalid_ack')
      socket.serializeAttachment({...state,acked:ack.seq})
    } catch { socket.close(1008,'invalid acknowledgement or expired login') }
  }
  webSocketClose(socket,code,reason) {
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code,reason) } catch {}
  }
  async fetch(request) {
    const url=new URL(request.url),service=this.service
    let tracked=false
    try {
      if (request.method==='POST' && url.pathname==='/internal/notifications/ingest') {
        service.assertAvailable()
        const generation=service.lifecycle.generation()
        service.activeRequests++;tracked=true
        const body=await payload(request)
        await service.host.arm()
        service.assertAvailable(generation)
        const result=await service.notifications.ingest(body)
        service.host.kick()
        return json(result,result.accepted===false ? 410 : 202)
      }
      // These status/cleanup endpoints remain readable while lifecycle fencing
      // blocks normal work. The edge has already verified the account JWT.
      if (request.method==='GET' && url.pathname==='/v1/account/status') return json(service.lifecycle?.status() || {state:'active',generation:1})
      if (request.method==='POST' && /^\/v1\/account\/(reset|delete|retry)$/.test(url.pathname)) {
        requireThat(service.lifecycle,'lifecycle_not_configured',503)
        const expectedGeneration=service.lifecycle.generation()
        const body=await payload(request)
        const replay=typeof body.requestId==='string' && service.store.one('SELECT id FROM account_lifecycle_requests WHERE id=?',body.requestId)
        const action=url.pathname.split('/').at(-1)
        if (action!=='retry' && !replay) {
          service.assertAvailable(expectedGeneration)
          body.expectedGeneration ??= expectedGeneration
          service.sessions.accept({sessionId:request.headers.get('X-Maco-Session'),issuedAt:Number(request.headers.get('X-Maco-Issued-At')),expires:Number(request.headers.get('X-Maco-Expires'))})
        }
        await service.host.arm()
        if (action!=='retry' && !replay) {
          service.assertAvailable(expectedGeneration)
          service.sessions.assertActive(request.headers.get('X-Maco-Session'))
        }
        const result=action==='retry' ? service.lifecycle.retry(body) : action==='delete' ? service.lifecycle.delete(body) : service.lifecycle.reset(body)
        service.host.kick()
        return json(result,202)
      }
      service.assertAvailable()
      const authorization=service.sessions.accept({sessionId:request.headers.get('X-Maco-Session'),issuedAt:Number(request.headers.get('X-Maco-Issued-At')),expires:Number(request.headers.get('X-Maco-Expires'))})
      const generation=service.lifecycle?.generation()
      const assertAuthorized=()=>{service.assertAvailable(generation);service.sessions.assertActive(authorization.sessionId)}
      authorization.assertCurrent=assertAuthorized
      service.activeRequests++;tracked=true
      const response=await this.dispatchAuthorized(request,authorization,assertAuthorized)
      if (authorization.revokedByRequest) service.assertAvailable(generation)
      else assertAuthorized()
      return response
    } catch (error) { return fail(error) }
    finally {
      if (tracked) service.activeRequests--
      if (service.lifecycle && service.lifecycle.status().state!=='active') service.host?.kick()
    }
  }
  async dispatchAuthorized(request,authorization,assertAuthorized) {
    const url = new URL(request.url)
    const path = url.pathname
    const service = this.service
    const vault = service.connections
    try {
      service.assertAvailable()
      if (path === '/v1/chat') return await forwardScheduledMail(request,this.env.MACO_SCHEDULED_MAIL,assertAuthorized)
      if (request.method === 'PUT' && path === '/v1/assets') {
        await service.host.arm()
        assertAuthorized()
        const taskId=url.searchParams.get('taskId') || undefined
        if (taskId) service.store.getTask(taskId)
        const length=request.headers.get('Content-Length')
        const asset=await service.assets.put({name:url.searchParams.get('name') || 'attachment',
          mimeType:request.headers.get('Content-Type')?.split(';')[0] || 'application/octet-stream',
          body:request.body,size:length===null ? undefined : Number(length),taskId,
          expectedSha256:request.headers.get('X-Content-SHA256') || undefined,
          idempotencyKey:request.headers.get('Idempotency-Key') || undefined,signal:request.signal,assertAuthorized})
        service.host.kick()
        return json({asset},201)
      }
      if (request.method === 'GET') {
        if (path === '/v1/status') return json(service.status())
        if (path === '/v1/sessions') return json({...service.sessions.list(),currentSessionId:authorization.sessionId})
        if (path === '/v1/notifications') return json(service.notifications.status())
        if (path === '/v1/notifications/deliveries') return json(service.notifications.deliveryPage({before:numberParam(url,'before',Number.MAX_SAFE_INTEGER),limit:numberParam(url,'limit',50)}))
        if (path === '/v1/socket') return this.subscribe(request,url)
        if (path === '/v1/events') return json(this.replay(numberParam(url,'after',0)))
        if (path === '/v1/schedules') return json(service.schedules.list())
        if (path === '/v1/usage') return json(service.usage.page({before:numberParam(url,'before',Number.MAX_SAFE_INTEGER)}))
        if (path === '/v1/account/export') return json(service.lifecycle.export({cursor:url.searchParams.get('cursor') || undefined,limit:numberParam(url,'limit',50)}))
        if (path === '/v1/metrics') return json({timings:service.store.timings()})
        if (path === '/v1/snapshot') return json(service.snapshot())
        if (path === '/v1/tasks') return json(service.store.taskPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER),url.searchParams.get('active')==='1'))
        if (path === '/v1/pending') return json(service.store.pendingPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER)))
        if (path === '/v1/operations') return json(service.store.operationPage(numberParam(url,'before',Number.MAX_SAFE_INTEGER)))
        if (path === '/v1/connections') return json({connections:vault.list()})
        if (path === '/v1/connectors') return json({connections:service.connectors.list(),servers:service.connectors.servers()})
        if (path === '/v1/connectors/tools') return json({tools:service.connectors.tools(url.searchParams.get('connectionId') || undefined)})
        if (path === '/v1/connectors/operations') return json(service.connectors.operationPage({before:numberParam(url,'before',Number.MAX_SAFE_INTEGER),pending:url.searchParams.get('pending')==='1'}))
        const connectorOperation=/^\/v1\/connectors\/operations\/([\w:.-]+)$/.exec(path)
        if (connectorOperation) {
          const operation=service.connectors.operation(connectorOperation[1])
          requireThat(operation,'operation_not_found',404)
          return json(operation)
        }
        if (path === '/v1/interactions') return json(service.interactions.list({before:numberParam(url,'before',Number.MAX_SAFE_INTEGER),waiting:url.searchParams.get('waiting')==='1'}))
        if (path === '/v1/work-items') return json(service.clientState.workItems({before:numberParam(url,'before',Number.MAX_SAFE_INTEGER),active:url.searchParams.get('active')==='1'}))
        if (path === '/v1/executions') return json(service.hosted.list({parentTaskId:url.searchParams.get('taskId') || undefined,before:numberParam(url,'before',Number.MAX_SAFE_INTEGER)}))
        const execution=/^\/v1\/executions\/([\w-]+)$/.exec(path)
        if (execution) return json(service.hosted.inspect(execution[1]))
        if (path === '/v1/assets') return json(service.assets.list({taskId:url.searchParams.get('taskId') || undefined,before:numberParam(url,'before',Number.MAX_SAFE_INTEGER)}))
        const asset=/^\/v1\/assets\/(asset_[a-f0-9-]+)(?:\/(download|text|search))?$/.exec(path)
        if (asset) {
          if (!asset[2]) return json({asset:service.assets.get(asset[1])})
          if (asset[2]==='download') {
            const result=await service.assets.download(asset[1],{signal:request.signal,assertAuthorized})
            // Always download; never execute uploaded HTML/SVG on the Worker origin.
            return new Response(result.body,{headers:{'Content-Type':result.asset.mimeType,'Content-Length':String(result.asset.size),
              'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(result.asset.name),
              'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"}})
          }
          await service.host.arm()
          assertAuthorized()
          const result=asset[2]==='text' ? await service.assets.read(asset[1],{offset:numberParam(url,'offset',0),
            page:url.searchParams.has('page') ? numberParam(url,'page',1) : undefined}) :
            await service.assets.search(asset[1],{query:url.searchParams.get('query') || ''})
          service.host.kick()
          return json(result)
        }
        const parse=/^\/v1\/asset-parses\/([\w-]+)$/.exec(path)
        if (parse) return json({job:service.assets.parseJob(parse[1])})
        if (path === '/v1/conversations') {
          const rows=service.store.rows(`SELECT COALESCE(json_extract(data,'$.conversationId'),'primary') AS id,
            MAX(json_extract(data,'$.updatedAt')) AS updatedAt,COUNT(*) AS taskCount FROM tasks GROUP BY 1 ORDER BY updatedAt DESC LIMIT 100`)
          return json({conversations:rows.length ? rows : [{id:'primary',taskCount:0}]})
        }
        const conversation=/^\/v1\/conversations\/([\w.@:-]+)\/messages$/.exec(path)
        if (conversation) return json(service.timeline({conversationId:conversation[1],before:numberParam(url,'before',Number.MAX_SAFE_INTEGER)}))
        if (path === '/v1/memory') return json(service.memory.list({includeDeleted:url.searchParams.get('deleted')==='1',limit:numberParam(url,'limit',200)}))
        if (path === '/v1/memory/context') return json(service.memory.context(url.searchParams.get('taskId') || '',{query:url.searchParams.get('query') || undefined}))
        if (path === '/v1/mail/messages') return json(await service.mailUI.list({mailboxId:url.searchParams.get('mailboxId'),
          query:url.searchParams.get('query') || '',folderId:url.searchParams.get('folderId') || undefined,cursor:url.searchParams.get('cursor') || undefined,
          limit:numberParam(url,'limit',30),after:url.searchParams.get('after') || undefined,before:url.searchParams.get('before') || undefined,
          unread:url.searchParams.has('unread') ? url.searchParams.get('unread')==='1' : undefined},assertAuthorized))
        if (path === '/v1/mail/folders') return json(await service.mailUI.folders({mailboxId:url.searchParams.get('mailboxId'),
          parentId:url.searchParams.get('parentId') || undefined,cursor:url.searchParams.get('cursor') || '',limit:numberParam(url,'limit',50)},assertAuthorized))
        if (path === '/v1/mail/aliases') return json(await service.mailUI.aliases({mailboxId:url.searchParams.get('mailboxId')},assertAuthorized))
        if (path === '/v1/mail/configured-aliases') return json(await vault.configuredAliases(url.searchParams.get('mailboxId'),{assertAuthorized}))
        if (path === '/v1/mail/configured-settings') return json(await vault.configuredMailboxSettings(url.searchParams.get('mailboxId'),{assertAuthorized}))
        if (path === '/v1/mail/delta') return json(service.mailUI.delta({mailboxId:url.searchParams.get('mailboxId'),after:numberParam(url,'after',0),limit:numberParam(url,'limit',100)}))
        if (path === '/v1/mail/raw') {
          const mime=await service.mailUI.raw({mailboxId:url.searchParams.get('mailboxId'),messageId:url.searchParams.get('messageId')},assertAuthorized)
          return new Response(mime.bytes,{headers:{'Content-Type':mime.mimeType,'Content-Disposition':'attachment; filename="message.eml"',
            'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}})
        }
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
        assertAuthorized()
        if (path === '/v1/commands') return json(await service.command(body,authorization),202)
        if (path.startsWith('/v1/notifications/')) {
          await service.host.arm()
          assertAuthorized()
          let result
          if (path==='/v1/notifications/installations/upsert') result=await service.notifications.putInstallation(body,{assertAuthorized})
          else if (path==='/v1/notifications/installations/revoke') result=service.notifications.revokeInstallation(body)
          else if (path==='/v1/notifications/watch') result=await service.notifications.watch(body,{assertAuthorized})
          else if (path==='/v1/notifications/unwatch') result=service.notifications.unwatch(body)
          else throw new ApiError(404,'not_found')
          service.host.kick()
          return json(result,202)
        }
        if (path === '/v1/mail/read') return json(await service.read(body,{assertAuthorized}))
        if (path === '/v1/mail/analysis') return json(service.clientState.analysis(body))
        if (path === '/v1/mail/configured-aliases') return json(await vault.mergeConfiguredAliases(body,{assertAuthorized}))
        if (path === '/v1/mail/configured-settings') return json(await vault.saveConfiguredMailboxSettings(body,{assertAuthorized}))
        if (path === '/v1/mail/configured-aliases/remove') return json(await vault.removeConfiguredAlias(body,{assertAuthorized}))
        if (path === '/v1/mail/configured-aliases/edit') return json(await vault.editConfiguredAlias(body,{assertAuthorized}))
        if (path === '/v1/mail/attachments/import') {
          const meta=service.mail.metadata(body.mailboxId)
          const input=service.index.resolveInput(body.mailboxId,{messageId:body.messageId})
          if (body.taskId) {
            const task=service.store.getTask(body.taskId)
            requireThat((task.mailboxIds || [task.mailboxId]).includes(body.mailboxId),'mailbox_not_in_task',403)
          }
          await service.host.arm()
          assertAuthorized()
          const asset=await service.assets.importMail({mailboxId:body.mailboxId,messageId:input.messageId,attachmentId:body.attachmentId,
            expectedEpoch:body.expectedEpoch ?? meta.epoch,taskId:body.taskId,signal:request.signal,assertAuthorized})
          service.host.kick()
          return json({asset},201)
        }
        if (path === '/v1/connectors/token') {
          const connection=await service.connectors.put(body,{assertAuthorized});service.resourcesChanged();return json(connection)
        }
        if (path === '/v1/connectors/oauth/start') return json(await service.connectors.beginOAuth(body,{assertAuthorized}))
        if (path === '/v1/connectors/oauth/complete') {
          const connection=await service.connectors.completeOAuth(body,{assertAuthorized});service.resourcesChanged();return json(connection)
        }
        if (path === '/v1/connectors/discover') return json(await service.connectors.discover({...body,signal:request.signal},{assertAuthorized}))
        if (path === '/v1/connectors/revoke') {
          const connection=service.connectors.revoke(body.id,body.expectedEpoch);service.resourcesChanged();return json(connection)
        }
        if (path === '/v1/connectors/read') return json({result:await service.connectors.read({...body,taskId:undefined,runId:undefined,signal:request.signal},{assertAuthorized})})
        if (path === '/v1/history/search') return json(service.queryHistory('history_search',body))
        if (path === '/v1/history/read') return json(service.queryHistory('history_read',body))
        let connection
        switch (path) {
          case '/v1/connections/model': connection = await vault.putModel(body,{assertAuthorized}); break
          case '/v1/connections/oauth/start': return json(await vault.beginOAuth(body,{assertAuthorized}))
          case '/v1/connections/oauth/complete': connection = await vault.completeOAuth(body,{assertAuthorized}); break
          case '/v1/connections/actions': connection = await vault.updateActions(body.id,body.actions,body.expectedEpoch); break
          case '/v1/connections/revoke':
            connection = await vault.revoke(body.id,body.expectedEpoch,{removeAliases:true})
            if (connection.kind === 'mail') service.index.clearMailbox(connection.id)
            break
          default: throw new ApiError(404,'not_found')
        }
        assertAuthorized()
        service.resourcesChanged()
        service.store.event('connection.updated',{connection})
        return json(connection)
      }
      throw new ApiError(404,'not_found')
    } catch (error) { return fail(error) }
  }
}

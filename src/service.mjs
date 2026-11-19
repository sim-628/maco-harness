import { withDeadline } from './deadline.mjs'
import { Store, operationView, taskView, publicMessage } from './store.mjs'
import { MailCommandExecutor } from './mail-executor.mjs'
import { Harness } from './harness.mjs'
import { ExecutionHost } from './scheduler.mjs'
import { ConnectionStore } from './connections/index.mjs'
import { mailCapabilities, readMailTool, mailToolsFor } from './mail/index.mjs'
import { validateTool } from './tool-policy.mjs'
import { modelCapabilities } from './model/index.mjs'
import { MemoryService } from './memory/index.mjs'
import { MailIndexService } from './mail-index/index.mjs'
import { CompactionService } from './model/compaction.mjs'
import { AssetService } from './assets/index.mjs'
import { ConnectorService } from './connectors/index.mjs'
import { HostedExecutionService } from './executors/index.mjs'
import { InteractionService } from './interactions.mjs'
import { MailReadService } from './mail-ui.mjs'
import { ClientStateService } from './client-state.mjs'
import { AccountLifecycleService } from './account/index.mjs'
import { ScheduleService } from './schedules.mjs'
import { UsageService } from './usage.mjs'
import { SessionService } from './sessions.mjs'
import { AccountNotificationService } from './notifications/index.mjs'
import { RuntimeTools } from './runtime-tools.mjs'
import { assertResources, historyScope, activeTaskStates } from './task-scope.mjs'
import { HISTORY_TOOLS } from './history/index.mjs'
import { fingerprint, identifier, requireThat, PROTOCOL_VERSION, checkedVersion, errorCode } from './protocol.mjs'

export class AgentService {
  constructor(ctx,env,{connections,emit,model,mail,fetcher=fetch} = {}) {
    Object.assign(this,{ctx,env,activeRequests:0})
    this.store = new Store(ctx.storage,emit)
    this.connections = connections || new ConnectionStore(ctx.storage,env,{transaction:fn=>this.store.tx(fn)})
    this.store.rows('CREATE TABLE IF NOT EXISTS operation_sessions (operation TEXT PRIMARY KEY,kind TEXT NOT NULL,session TEXT NOT NULL)')
    this.usage = new UsageService(this.store)
    this.store.onEvent=(type,fields)=>this.observeEvent(type,fields)
    this.sessions = new SessionService(this.store,{onRevoke:id=>this.revokeSessionWork(id)})
    this.index = new MailIndexService(this.store)
    this.memory = new MemoryService(this.store,{connections:this.connections,stream:model?.stream,assertCurrent:job=>{this.assertAvailable();this.sessions.assertActive(job.authorizationSession)}})
    const limit = (value,fallback,min,max) => {
      const n = value === undefined ? fallback : Number(value)
      requireThat(Number.isSafeInteger(n) && n >= min && n <= max,'invalid_capacity_configuration',500)
      return n
    }
    const maxInputBytes = limit(env.CONTEXT_INPUT_BYTES,65536,16384,131072)
    this.compaction = new CompactionService(this.store,{
      stream:model?.stream,maxInputBytes,
      retainBytes:Math.min(12000,Math.floor(maxInputBytes*0.2)),
      maxSummaryBytes:Math.min(6000,Math.floor(maxInputBytes*0.1))
    })
    this.mail = new MailCommandExecutor(this.store,this.connections,{
      ...mail,maxPending:limit(env.MAX_PENDING_OPERATIONS,256,30,2048),
      resolveInput:(mailboxId,input) => this.index.resolveInput(mailboxId,input),
      readAsset:async (id,options)=>{this.authorizeAsset(id,options);return this.assets.bytes(id,options)},
      assertAsset:(id,options)=>this.authorizeAsset(id,options),
      assertCurrent:op=>{
        this.assertAvailable()
        if (op) {
          this.assertOperationSession(op.id)
          if (op.taskId) assertResources(this.store.getTask(op.taskId),this.connections,this.runtime)
        }
      },
      onSettled:op => {
        if (['succeeded','unknown'].includes(op.state)) this.index.invalidate(op.mailboxId)
        mail?.onSettled?.(op)
      }})
    this.store.rows('CREATE TABLE IF NOT EXISTS runtime_identity (singleton INTEGER PRIMARY KEY,owner TEXT NOT NULL)')
    this.store.rows('INSERT OR IGNORE INTO runtime_identity VALUES (1,?)',ctx.id?.toString() || crypto.randomUUID())
    const ownerId=this.store.one('SELECT owner FROM runtime_identity WHERE singleton=1').owner
    this.notifications = new AccountNotificationService(this.store,env,{ownerId,fetcher,
      mailContext:(mailboxId,epoch)=>this.mail.context(mailboxId,epoch),
      mailMetadata:(mailboxId,epoch)=>this.mail.metadata(mailboxId,epoch),
      onMailEvent:({mailboxId,provider})=>{
        this.assertAvailable()
        // Push notifications are a wake-up signal, never a replacement for a
        // provider-verified incremental cursor or the actual mail contents.
        if (!this.index.syncState(mailboxId)) this.index.startSync(mailboxId,provider)
        else this.index.invalidate(mailboxId)
        this.store.event('mail.sync_requested',{mailboxId,provider})
      }})
    this.assets = new AssetService(this.store,env,{ownerId,mail:this.mail,fetcher,assertCurrent:()=>this.assertAvailable()})
    this.connectors = new ConnectorService(this.store,env,{fetcher,
      assertOwner:scope=>this.assertConnectorOwner(scope),onSettled:op=>this.wakeTask(op.taskId,op.runId,
        op.state==='unknown' ? 'needs_review' : 'queued',op.operationId)})
    this.hosted = new HostedExecutionService(this.store,env,{assets:this.assets,connections:this.connections,fetcher,
      assertCurrent:job=>this.assertExecution(job),onComplete:execution=>this.wakeTask(execution.parentTaskId,execution.runId,'queued',execution.executionId),
      onInvalidated:(execution,reason)=>this.invalidatedExecution(execution,reason)})
    this.interactions = new InteractionService(this.store,{onSettled:interaction=>this.wakeTask(interaction.taskId,interaction.runId,'queued',interaction.interactionId)})
    this.mailUI = new MailReadService(this)
    this.clientState = new ClientStateService(this.store,{mail:this.mail,index:this.index})
    this.runtime = new RuntimeTools(this)
    this.harness = new Harness(this.store,this.connections,this.mail,{
      ...model,memory:this.memory,compaction:this.compaction,extensions:this.runtime,maxOpenTasks:limit(env.MAX_OPEN_TASKS,32,1,256),
      read:(name,input,ctx) => this.readProvider(name,input,ctx,model?.read || readMailTool)})
    this.schedules = new ScheduleService(this.store,{harness:this.harness,assertCurrent:schedule=>{
      this.assertAvailable()
      this.sessions.assertActive(schedule.authorizationSession)
      this.connections.assertEpoch(schedule.binding.profile.connectionId,schedule.binding.modelEpoch)
      assertResources(schedule.binding,this.connections,this.runtime)
    }})
    this.lifecycle = new AccountLifecycleService(this.store,{assets:this.assets,connections:this.connections,
      connectors:this.connectors,executors:this.hosted,memory:this.memory,sessions:this.sessions,
      participants:[{name:'notifications',activeCount:()=>this.notifications.activeCount(),
        fence:({mode})=>this.notifications.fence({revokeInstallations:mode==='delete',unsubscribe:mode==='delete'}),
        cleanup:async({mode})=>{if (mode==='delete') await this.notifications.erase();return {complete:true}}}],
      onFence:()=>{
        this.host?.abortAll()
        for (const socket of ctx.getWebSockets?.() || []) try {socket.close(1008,'account changed')} catch {}
      },activeCount:()=>this.activeRequests+(this.host?.tasks.size || 0)+(this.host?.ops.size || 0)+
        [...(this.host?.jobs.keys() || [])].filter(name=>name!=='lifecycle').length})
    this.host = new ExecutionHost(ctx,this.store,this.harness,this.mail,{enabled:()=>this.lifecycle.status().state==='active',maintenance:[
      {name:'lifecycle',duringLifecycle:true,recover:()=>this.lifecycle.recover(),nextDue:()=>this.lifecycle.nextDue(),run:signal=>this.lifecycle.runNext(signal)},
      {name:'schedules',nextDue:()=>this.schedules.nextDue(),run:()=>this.schedules.runNext()},
      {name:'assets',timeoutMs:195000,recover:()=>this.assets.recover(),nextDue:()=>this.assets.nextDue(),
        run:async signal=>{await this.assets.runNext(signal);this.wakeAssetTasks()}},
      {name:'hosted',recover:()=>this.hosted.recover(),nextDue:()=>this.hosted.nextDue(),run:signal=>this.hosted.runNext(signal)},
      {name:'connectors',recover:()=>this.connectors.recover(),nextDue:()=>this.connectors.nextDue(),run:signal=>this.connectors.runNext({signal})},
      {name:'notifications',recover:()=>this.notifications.recover(),nextDue:()=>this.notifications.nextDue(),run:signal=>this.notifications.runNext({signal})},
      {name:'memory',idleOnly:true,recover:() => this.memory.recover(),
        nextDue:() => this.memory.nextDue(),run:signal => this.memory.runPending({signal})},
      {name:'mail_index',nextDue:() => this.index.nextDue(),run:async signal => {
        const mailboxId = this.index.dueMailboxes()[0]
        if (!mailboxId) return
        try {
          const meta = this.mail.metadata(mailboxId)
          const context = await this.mail.context(mailboxId,meta.epoch)
          await this.index.syncNext({...context,signal,assertCurrent:() => this.connections.assertEpoch(mailboxId,meta.epoch)})
        } catch (error) { this.index.deferSync(mailboxId,error) }
      }}
    ]})
  }
  observeEvent(type,fields) {
    this.usage.record(type,fields)
    if (!this.notifications) return
    let notification
    if (type==='task.updated' && fields.state==='completed') notification={kind:'task.completed',taskId:fields.taskId,dedupeKey:'task:'+fields.runId}
    else if (type==='mail.updated' && fields.state==='waiting_approval') notification={kind:'approval.required',taskId:fields.taskId || undefined,
      dedupeKey:'mail:'+fields.operationId+':'+fields.approvalVersion}
    else if (type==='connector.operation.updated' && fields.operation.state==='waiting_approval') notification={kind:'approval.required',
      taskId:fields.operation.taskId || undefined,dedupeKey:'connector:'+fields.operation.operationId+':'+fields.operation.approvalVersion}
    else if (type==='interaction.updated' && fields.interaction.state==='waiting') notification={kind:'approval.required',
      taskId:fields.interaction.taskId,dedupeKey:'interaction:'+fields.interaction.interactionId}
    if (notification && (!this.lifecycle || this.lifecycle.row().state==='active')) this.notifications.enqueue(notification)
  }
  invalidatedExecution(execution,reason) {
    const row=this.store.one('SELECT data FROM tasks WHERE id=?',execution.parentTaskId)
    if (!row) return
    const task=JSON.parse(row.data)
    if (task.runId!==execution.runId || task.version!==execution.runVersion || task.state!=='waiting_external' ||
      task.waitingExternalId!==execution.executionId) return
    while (task.pending) this.harness.commitTool(task,task.pending.calls[task.pending.index],{error:reason,executed:false})
    task.state='failed';task.error=reason;task.waiting=null;task.waitingExternalId=null;task.version++
    this.store.saveTask(task)
  }
  resourcesChanged() {
    this.store.tx(()=>{
      for (const row of this.store.rows(`SELECT data FROM tasks WHERE state IN (${activeTaskStates.filter(state=>state!=='needs_review').map(()=>'?').join(',')})`,
        ...activeTaskStates.filter(state=>state!=='needs_review'))) {
        const task=JSON.parse(row.data)
        try {this.connections.assertEpoch(task.profile.connectionId,task.modelEpoch);assertResources(task,this.connections,this.runtime)}
        catch(error) {
          this.harness.stopPending(task)
          task.state='failed';task.error=errorCode(error,'task_authority_changed');task.version++
          task.waiting=null;task.waitingExternalId=null;task.waitingInteractionId=null;task.waitingOperationId=null
          this.store.saveTask(task);this.host?.abort(task.id)
        }
      }
    })
    this.host?.kick()
  }
  authorizeAsset(id,{assetIds,mailboxIds}={}) {
    if (assetIds) requireThat(assetIds.includes(id),'asset_not_in_task',403)
    const asset=this.assets.get(id)
    if (mailboxIds) this.runtime.checkAssetSource(asset,mailboxIds)
    return asset
  }
  bindOperationSession(id,kind,sessionId) {
    if (sessionId) this.store.rows('INSERT INTO operation_sessions VALUES (?,?,?)',id,kind,sessionId)
  }
  assertOperationSession(id) {
    const row=this.store.one('SELECT session FROM operation_sessions WHERE operation=?',id)
    if (row) this.sessions.assertActive(row.session)
  }
  privacyChanged() {
    for (const row of this.store.rows("SELECT data FROM tasks WHERE state='waiting_external'")) {
      const task=JSON.parse(row.data)
      if (!task.pending || task.pending.memoryEpoch===this.memory.state().epoch) continue
      this.hosted.cancelForTask(task.id,'memory_context_changed')
      this.harness.commitTool(task,task.pending.calls[task.pending.index],{error:'memory_context_changed',state:'cancel_requested',executionId:task.waitingExternalId})
      task.state='queued';task.waiting=null;task.waitingExternalId=null;task.due=0
      this.store.saveTask(task)
    }
  }
  revokeSessionWork(id) {
    for (const row of this.store.rows("SELECT data FROM tasks WHERE json_extract(data,'$.authorizationSession')=?",id)) {
      const task=JSON.parse(row.data)
      if (!['queued','running','waiting_mail','waiting_external','waiting_connector','waiting_user'].includes(task.state)) continue
      this.harness.stopPending(task)
      task.version++;task.state='cancelled';task.error='session_revoked'
      this.store.saveTask(task);this.host?.abort(task.id)
    }
    this.store.rows("UPDATE memory_jobs SET state='cancelled' WHERE json_extract(data,'$.authorizationSession')=? AND state IN ('queued','running')",id)
    for (const row of this.store.rows('SELECT operation,kind FROM operation_sessions WHERE session=?',id)) {
      if (row.kind==='mail') {
        const op=this.store.getOp(row.operation)
        if (op && ['waiting_approval','queued'].includes(op.state)) {
          op.state='cancelled';op.version++;delete op.prepared.payload;this.store.saveOp(op);this.mail.wakeTask(op)
        }
      } else {
        const op=this.connectors.operation(row.operation)
        if (op && ['waiting_approval','queued'].includes(op.state)) this.connectors.cancel({operationId:row.operation,approvalVersion:op.approvalVersion})
      }
    }
    for (const socket of this.ctx.getWebSockets?.() || []) {
      if (socket.deserializeAttachment()?.sessionId===id) try {socket.close(1008,'session revoked')} catch {}
    }
  }
  assertAvailable(generation) { this.lifecycle?.assertActive(generation) }
  assertConnectorOwner({taskId,runId,connectionId,operationId,signal}={}) {
    this.assertAvailable()
    signal?.throwIfAborted()
    if (operationId) this.assertOperationSession(operationId)
    if (!taskId) return
    const task=this.store.getTask(taskId)
    requireThat(task.runId===runId && ['running','queued','waiting_connector'].includes(task.state),'run_superseded',409)
    requireThat(task.connectorIds?.includes(connectionId),'connector_not_in_task',403)
    this.sessions.assertActive(task.authorizationSession)
    this.connections.assertEpoch(task.profile.connectionId,task.modelEpoch)
    assertResources(task,this.connections,this.runtime)
  }
  assertExecution(job) {
    this.assertAvailable()
    const task=this.store.getTask(job.parentTaskId)
    requireThat(task.runId===job.runId && task.version===job.runVersion && ['running','queued','waiting_external'].includes(task.state),'run_superseded',409)
    this.sessions.assertActive(task.authorizationSession)
    this.connections.assertEpoch(task.profile.connectionId,job.authority.modelEpoch)
    requireThat(job.authority.memoryEpoch===this.memory.state().epoch,'memory_context_changed',409)
    assertResources(task,this.connections,this.runtime)
    return true
  }
  wakeTask(taskId,runId,state='queued',waitingId) {
    if (!taskId) return
    const row=this.store.one('SELECT data FROM tasks WHERE id=?',taskId)
    if (!row) return
    const task=JSON.parse(row.data)
    if (task.runId!==runId || !['waiting_connector','waiting_external','waiting_user','needs_review'].includes(task.state)) return
    if (waitingId && ![task.waitingOperationId,task.waitingExternalId,task.waitingInteractionId].includes(waitingId)) return
    task.state=state;task.due=0
    this.store.saveTask(task)
    this.host?.kick()
  }
  wakeAssetTasks() {
    this.store.tx(()=>{
      for (const row of this.store.rows("SELECT data FROM tasks WHERE state='waiting_external' AND json_extract(data,'$.waiting.kind')='asset'")) {
        const task=JSON.parse(row.data)
        let job
        try { job=this.assets.parseJob(task.waitingExternalId) } catch { job=null }
        if (!job || ['succeeded','failed','unknown','cancelled'].includes(job.state)) this.wakeTask(task.id,task.runId,'queued',task.waitingExternalId)
      }
    })
  }
  status() {
    return {service:'maco-harness',version:'0.4.0',protocolVersion:1,
      deployment:'independent',features:{multiMailbox:true,multiTask:true,conversations:true,
        mailMutations:'provider_api',mailAnalysis:'on_device_sync',history:true,preferences:true,
        interactions:true,workItems:true,scheduledReadOnlyTasks:true,usage:true,assets:this.assets.capabilities(),hosted:this.hosted.capabilities(),
        connectors:{enabled:this.connectors.servers().length>0,servers:this.connectors.servers()},notifications:this.notifications.capabilities()},
      limits:{foregroundConcurrency:2,mailWriteConcurrency:4,maxOpenTasks:this.harness.maxOpenTasks},
      account:this.lifecycle?.status() || {state:'active'}}
  }
  snapshot() {
    return {...this.store.snapshot(),interactions:this.interactions.list({waiting:true}),
      workItems:this.clientState.workItems({active:true}),executions:this.hosted.list(),
      connectorOperations:this.connectors.operationPage({pending:true})}
  }
  timeline({conversationId='primary',before=Number.MAX_SAFE_INTEGER}={}) {
    identifier(conversationId,'conversation_id')
    const rows=this.store.rows(`SELECT m.n,m.task,m.data FROM messages m JOIN tasks t ON t.id=m.task
      WHERE COALESCE(json_extract(t.data,'$.conversationId'),'primary')=? AND m.n<? ORDER BY m.n DESC LIMIT 101`,conversationId,before)
    const page=rows.slice(0,100).reverse()
    return {conversationId,messages:page.map(row=>({taskId:row.task,...publicMessage(JSON.parse(row.data))})),
      nextBefore:rows.length>100 ? page[0].n : null,snapshotCursor:this.store.cursor()}
  }
  async command(body,authorization={}) {
    authorization.assertCurrent?.()
    this.assertAvailable()
    this.sessions.assertActive(authorization.sessionId)
    const receivedAt = Date.now()
    requireThat(body.protocolVersion === PROTOCOL_VERSION,'unsupported_protocol',426)
    const {type,commandId} = body
    identifier(commandId,'command_id')
    const digest = await fingerprint(body)
    const old = this.store.seen(commandId,digest)
    if (old) return old
    let apply
    switch (type) {
      case 'task.create': apply = () => this.harness.create({...body,authorizationSession:authorization.sessionId}); break
      case 'task.steer': apply = () => this.harness.steer({...body,authorizationSession:authorization.sessionId}); break
      case 'task.cancel': apply = () => this.harness.cancel(body); break
      case 'schedule.upsert': apply=()=>this.schedules.upsert(body,authorization.sessionId);break
      case 'schedule.cancel': apply=()=>this.schedules.cancel(body);break
      case 'session.revoke': apply=()=>this.sessions.revoke(body);break
      case 'session.revoke_all': apply=()=>this.sessions.revokeAll();break
      case 'interaction.respond': apply = () => this.interactions.respond(body); break
      case 'work_item.upsert': apply = () => this.clientState.workItem(body); break
      case 'mail.analysis.sync': apply = () => this.clientState.analysisBatch(body); break
      case 'asset.parse': apply = () => ({job:this.assets.parse(body.assetId,{parser:body.parser || 'auto',purpose:body.purpose,
        force:body.force,allowRetryUnknown:body.allowRetryUnknown})}); break
      case 'asset.delete': apply = () => {const result=this.assets.remove(body.assetId);this.resourcesChanged();return result}; break
      case 'execution.cancel': apply = () => ({execution:this.hosted.cancel(body.executionId,'user_cancelled')}); break
      case 'connector.submit': {
        const connection=this.connectors.get(identifier(body.connectionId,'connector_id'))
        const plan=await this.connectors.plan({connectionId:connection.id,expectedEpoch:body.expectedEpoch ?? connection.epoch,
          tool:body.tool,arguments:body.arguments || {}})
        apply = () => {
          const operation=this.connectors.accept(plan,{id:crypto.randomUUID(),commandId})
          this.bindOperationSession(operation.operationId,'connector',authorization.sessionId)
          return {operation}
        }
        break
      }
      case 'connector.approve': case 'connector.reject':
        apply = () => ({operation:this.connectors.decide({...body,approve:type==='connector.approve'})}); break
      case 'connector.cancel': apply = () => ({operation:this.connectors.cancel(body)}); break
      case 'connector.reconcile': apply = () => ({operation:this.connectors.reconcile(body)}); break
      case 'memory.upsert': apply = () => ({memory:this.memory.upsert(body)}); break
      case 'memory.delete': apply = () => {const memory=this.memory.remove(body);this.privacyChanged();return {memory}}; break
      case 'memory.configure': apply = () => {const settings=this.memory.configure(body);this.privacyChanged();return {settings}}; break
      case 'memory.proposal.approve': case 'memory.proposal.reject':
        apply = () => this.memory.decideProposal({...body,approve:type === 'memory.proposal.approve'})
        break
      case 'mail.sync':
        apply = () => {
          const mailboxId = identifier(body.mailboxId,'mailbox_id')
          const meta = this.mail.metadata(mailboxId)
          requireThat(mailToolsFor(meta).some(tool => tool.name === 'mail_search'),'scope_required',403)
          return {index:this.index.startSync(mailboxId,meta.provider,{after:body.after})}
        }
        break
      case 'mail.submit': {
        const {mailboxId,items} = body
        identifier(mailboxId,'mailbox_id')
        requireThat(Array.isArray(items) && items.length >= 1 && items.length <= 30,'invalid_mail_batch')
        this.mail.checkCapacity(items.length)
        const plans = []
        // Preparation is read-only. Bound frozen data and keep every effect behind the ledger.
        let size = 0
        for (const item of items) {
          requireThat(item && item.input,'invalid_mail_item')
          let plan
          try {
            plan = await this.mail.plan(item.input,{mailboxId,expectedRevision:item.expectedRevision,
              scheduledAt:item.scheduledAt,expectedProviderVersion:item.expectedProviderVersion})
          } catch (error) {
            // A concurrent retry may have already accepted this command and changed the mailbox.
            const accepted = this.store.seen(commandId,digest)
            if (accepted) return accepted
            throw error
          }
          size += JSON.stringify(plan).length
          requireThat(size <= 1_500_000,'batch_too_large',413)
          plans.push(plan)
        }
        apply = () => ({operations:plans.map(plan => {
          const operation=this.mail.accept(plan,{id:crypto.randomUUID(),commandId})
          this.bindOperationSession(operation.id,'mail',authorization.sessionId)
          return operationView(operation)
        })})
        break
      }
      case 'mail.approve': case 'mail.reject':
        apply = () => this.mail.decide(body.operationId,body.approvalVersion,type === 'mail.approve')
        break
      case 'mail.cancel':
        apply = () => {
          const op = this.store.getOp(identifier(body.operationId,'operation_id'))
          requireThat(op,'operation_not_found',404)
          checkedVersion(body.approvalVersion,op.version)
          requireThat(['waiting_approval','queued'].includes(op.state),'already_dispatched',409)
          op.state = 'cancelled'
          op.version++
          delete op.prepared.payload
          this.store.saveOp(op)
          this.mail.wakeTask(op)
          return operationView(op)
        }
        break
      case 'mail.reconcile': {
        // A human may attest to a provider-side check. Preserve both the ambiguous
        // receipt and its resolution and never infer non-delivery from a missing search hit.
        apply = () => {
          const op = this.store.getOp(identifier(body.operationId,'operation_id'))
          requireThat(op, 'operation_not_found',404)
          checkedVersion(body.approvalVersion,op.version)
          requireThat(op.state === 'unknown','not_awaiting_reconciliation',409)
          requireThat(['succeeded','failed'].includes(body.outcome) && typeof body.evidence === 'string' &&
            body.evidence.trim().length > 0 && body.evidence.length <= 1024,'provider_evidence_required')
          this.mail.settle(op,{status:body.outcome,code:'user_verified',evidence:body.evidence, priorReceipt:op.receipt})
          return operationView(op)
        }
        break
      }
      default: requireThat(false,'unknown_command')
    }
    await this.host.arm()
    let applied = false
    const result = this.store.command(commandId,digest,() => {
      authorization.assertCurrent?.()
      this.assertAvailable()
      this.sessions.assertActive(authorization.sessionId)
      const data = apply()
      applied = true
      return {protocolVersion:1,accepted:true,commandId,...data}
    })
    if (applied) {
      if (type==='session.revoke' || type==='session.revoke_all') authorization.revokedByRequest=true
      this.store.timing('command_accept',Date.now()-receivedAt)
      if (type === 'task.cancel' || type === 'task.steer') this.host.abort(body.taskId)
      this.host.kick()
    }
    return result
  }
  async readProvider(tool,input,ctx,read = readMailTool) {
    const generation=this.lifecycle?.generation()
    const epoch = this.mail.metadata(ctx.mailboxId,ctx.epoch).epoch
    const normalized = this.index.resolveInput(ctx.mailboxId,input)
    const key = tool === 'mail_read' ? JSON.stringify([ctx.mailboxId,'message:'+normalized.messageId]) : null
    const before = key && this.mail.checkRevision(key)
    const assertCurrent = () => {
      this.assertAvailable(generation)
      ctx.assertCurrent?.()
      this.connections.assertEpoch(ctx.mailboxId,epoch)
      if (key) this.mail.checkRevision(key,before)
    }
    // Index projection, optimistic revision and its event share one synchronous
    // commit. A rejected late read must not leave stale metadata behind.
    const commitResult = result => {
      if (!key || !result?.version) return result
      const providerVersion = String(result.version)
      const prior = this.store.one('SELECT providerVersion FROM mail_observations WHERE resource=?',key)
      let revision = before
      if (prior?.providerVersion !== providerVersion) {
        revision = this.store.one('INSERT INTO revisions VALUES (?,1,?) ON CONFLICT(resource) DO UPDATE SET revision=revision+1 RETURNING revision',key,normalized.messageId).revision
        this.store.rows('INSERT INTO mail_observations VALUES (?,?) ON CONFLICT(resource) DO UPDATE SET providerVersion=excluded.providerVersion',key,providerVersion)
        this.store.event('mail.observed',{mailboxId:ctx.mailboxId,messageId:result.citation?.messageId || input.messageId,revision,providerVersion})
      }
      return {...result,revision,providerVersion}
    }
    return this.index.read(tool,normalized,{...ctx,assertCurrent,commitResult},read)
  }
  async read(body,{assertAuthorized}={}) {
    assertAuthorized?.()
    const meta = this.mail.metadata(identifier(body.mailboxId,'mailbox'))
    const ctx = await this.mail.context(body.mailboxId,meta.epoch)
    this.mail.metadata(body.mailboxId,meta.epoch)
    const tool = mailToolsFor(ctx.credential).find(tool => tool.name === body.tool && tool.name !== 'mail_write')
    requireThat(tool, 'read_tool_not_allowed',403)
    validateTool(tool.inputSchema,body.input ?? {})
    const result = await withDeadline(30000,null,signal => this.readProvider(body.tool,body.input || {},{...ctx,signal,assertCurrent:assertAuthorized}))
    assertAuthorized?.()
    this.mail.metadata(body.mailboxId,meta.epoch)
    return {result}
  }
  queryHistory(toolName,body) {
    const {callerTaskId,...input} = body
    const task = this.store.getTask(identifier(callerTaskId,'task_id'))
    // The JWT already selected this user's DO. Derive mailbox scope from an
    // existing task and live connection; neither tool nor HTTP input picks owner.
    assertResources(task,this.connections,this.runtime)
    const tool = HISTORY_TOOLS.find(tool => tool.name === toolName)
    requireThat(tool,'history_tool_not_allowed',403)
    validateTool(tool.inputSchema,input)
    const scope = historyScope(task,this.store.one('SELECT COALESCE(MAX(n),0)+1 AS n FROM messages WHERE task=?',task.id).n)
    const started = Date.now()
    const result = toolName === 'history_search' ? this.memory.history.search(input,scope) : this.memory.history.read(input,scope)
    this.store.timing('history_tool',Date.now()-started)
    return {result}
  }
  capabilities(id,model) {
    const meta = this.connections.get(id)
    requireThat(meta && meta.status === 'active','connection_not_found',404)
    if (meta.kind === 'model') return modelCapabilities({provider:meta.provider,model})
    return {epoch:meta.epoch,tools:mailToolsFor(meta),actions:mailCapabilities(meta).map(cap => ({
      ...cap, granted:meta.actions.includes(cap.action),executable:cap.supported && cap.authorized && meta.actions.includes(cap.action)}))}
  }
  history(taskId,before) {
    const task = this.store.getTask(taskId)
    const rows = this.store.rows('SELECT n,data FROM messages WHERE task=? AND n<? ORDER BY n DESC LIMIT 51',taskId,before)
    const page = rows.slice(0,50).reverse()
    return {...taskView(task),messages:page.map(row => publicMessage(JSON.parse(row.data))),nextBefore:rows.length>50 ? page[0].n : null}
  }
}

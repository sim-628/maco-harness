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
import { HISTORY_TOOLS } from './history/index.mjs'
import { fingerprint, identifier, requireThat, PROTOCOL_VERSION, checkedVersion } from './protocol.mjs'

export class AgentService {
  constructor(ctx,env,{connections,emit,model,mail} = {}) {
    this.store = new Store(ctx.storage,emit)
    this.connections = connections || new ConnectionStore(ctx.storage,env)
    this.index = new MailIndexService(this.store)
    this.memory = new MemoryService(this.store,{connections:this.connections,stream:model?.stream})
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
      onSettled:op => {
        if (['succeeded','unknown'].includes(op.state)) this.index.invalidate(op.mailboxId)
        mail?.onSettled?.(op)
      }})
    this.harness = new Harness(this.store,this.connections,this.mail,{
      ...model,memory:this.memory,compaction:this.compaction,maxOpenTasks:limit(env.MAX_OPEN_TASKS,32,1,256),
      read:(name,input,ctx) => this.readProvider(name,input,ctx,model?.read || readMailTool)})
    this.host = new ExecutionHost(ctx,this.store,this.harness,this.mail,{maintenance:[
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
  async command(body) {
    const receivedAt = Date.now()
    requireThat(body.protocolVersion === PROTOCOL_VERSION,'unsupported_protocol',426)
    const {type,commandId} = body
    identifier(commandId,'command_id')
    const digest = await fingerprint(body)
    const old = this.store.seen(commandId,digest)
    if (old) return old
    let apply
    switch (type) {
      case 'task.create': apply = () => this.harness.create(body); break
      case 'task.steer': apply = () => this.harness.steer(body); break
      case 'task.cancel': apply = () => this.harness.cancel(body); break
      case 'memory.upsert': apply = () => ({memory:this.memory.upsert(body)}); break
      case 'memory.delete': apply = () => ({memory:this.memory.remove(body)}); break
      case 'memory.configure': apply = () => ({settings:this.memory.configure(body)}); break
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
        apply = () => ({operations:plans.map(plan => operationView(this.mail.accept(plan,{id:crypto.randomUUID(),commandId})))})
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
      const data = apply()
      applied = true
      return {protocolVersion:1,accepted:true,commandId,...data}
    })
    if (applied) {
      this.store.timing('command_accept',Date.now()-receivedAt)
      if (type === 'task.cancel' || type === 'task.steer') this.host.abort(body.taskId)
      this.host.kick()
    }
    return result
  }
  async readProvider(tool,input,ctx,read = readMailTool) {
    const epoch = this.mail.metadata(ctx.mailboxId,ctx.epoch).epoch
    const normalized = this.index.resolveInput(ctx.mailboxId,input)
    const key = tool === 'mail_read' ? JSON.stringify([ctx.mailboxId,'message:'+normalized.messageId]) : null
    const before = key && this.mail.checkRevision(key)
    const assertCurrent = () => {
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
  async read(body) {
    const meta = this.mail.metadata(identifier(body.mailboxId,'mailbox'))
    const ctx = await this.mail.context(body.mailboxId,meta.epoch)
    this.mail.metadata(body.mailboxId,meta.epoch)
    const tool = mailToolsFor(ctx.credential).find(tool => tool.name === body.tool && tool.name !== 'mail_write')
    requireThat(tool, 'read_tool_not_allowed',403)
    validateTool(tool.inputSchema,body.input ?? {})
    const result = await withDeadline(30000,null,signal => this.readProvider(body.tool,body.input || {},{...ctx,signal}))
    this.mail.metadata(body.mailboxId,meta.epoch)
    return {result}
  }
  queryHistory(toolName,body) {
    const {callerTaskId,...input} = body
    const task = this.store.getTask(identifier(callerTaskId,'task_id'))
    // The JWT already selected this user's DO. Derive mailbox scope from an
    // existing task and live connection; neither tool nor HTTP input picks owner.
    this.mail.metadata(task.mailboxId)
    const tool = HISTORY_TOOLS.find(tool => tool.name === toolName)
    requireThat(tool,'history_tool_not_allowed',403)
    validateTool(tool.inputSchema,input)
    const scope = {callerTaskId:task.id,mailboxId:task.mailboxId,
      beforeN:this.store.one('SELECT COALESCE(MAX(n),0)+1 AS n FROM messages WHERE task=?',task.id).n}
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

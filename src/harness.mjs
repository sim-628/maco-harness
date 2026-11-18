import { streamStep, buildContext } from './model/index.mjs'
import { mailToolsFor, readMailTool } from './mail/index.mjs'
import { validateTool } from './tool-policy.mjs'
import { requireThat, errorCode, identifier, messageText, checkedVersion } from './protocol.mjs'
import { finishedOps } from './mail-executor.mjs'
import { taskView } from './store.mjs'
import { HISTORY_TOOLS } from './history/index.mjs'
import { projectHistoryMessage } from './history-projection.mjs'
import { ModelError } from './model/stream.mjs'

const LIMITS = {steps:12, tools:32, attempts:15, output:2048, reads:3}
const RUN_POLICY = 'maco-mail-v2'

export class Harness {
  constructor(store, connections, mail, {stream = streamStep, read = readMailTool, memory, compaction, maxOpenTasks = 32} = {}) {
    Object.assign(this, {store, connections, mail, stream, read, memory, compaction, maxOpenTasks})
  }
  bind(profile, mailboxId) {
    requireThat(profile && typeof profile === 'object', 'model_profile_required')
    requireThat(typeof profile.model === 'string' && profile.model.length > 0 && profile.model.length <= 200 && !/[\s\x00-\x1f\x7f]/u.test(profile.model), 'invalid_model')
    identifier(profile.connectionId,'connection')
    const model = this.connections.get(profile.connectionId)
    requireThat(model?.kind === 'model' && model.status === 'active' && model.provider === profile.provider, 'model_connection_mismatch', 403)
    const effort = profile.effort || 'provider-default'
    requireThat(['low','medium','high','provider-default'].includes(effort),'invalid_effort')
    const mailbox = this.mail.metadata(identifier(mailboxId,'mailbox'))
    return {profile:{provider:model.provider, model:profile.model, effort, connectionId:model.id},
      modelEpoch:model.epoch, mailboxId, mailEpoch:mailbox.epoch}
  }
  newRun(t, binding, message) {
    const open = this.store.one("SELECT COUNT(*) AS count FROM tasks WHERE state IN ('queued','running','waiting_mail','needs_review') AND id<>?",t.id).count
    requireThat(open < this.maxOpenTasks,'task_capacity_reached',429)
    Object.assign(t, binding, {runId:crypto.randomUUID(), runStartedAt:Date.now(), policyVersion:RUN_POLICY, state:'queued',
      step:0, toolCount:0, attempts:0, compactionAttempts:0, failures:0, pending:null, attempt:null, lastUsage:null, waitingOperationId:null, due:0, error:null,context:null})
    this.store.saveTask(t)
    this.store.event('run.started',{...taskView(t), policyVersion:RUN_POLICY})
    const turn = this.store.appendMessage(t, {role:'user',content:messageText(message)})
    this.memory?.observe(t.id,turn.messageId,{profile:t.profile,modelEpoch:t.modelEpoch})
    return taskView(t)
  }
  create({message, modelProfile, mailboxId, priority = 'foreground', timeZone = 'UTC'}) {
    requireThat(typeof timeZone === 'string' && timeZone.length < 80, 'invalid_time_zone')
    try { new Intl.DateTimeFormat('en',{timeZone}) } catch { requireThat(false,'invalid_time_zone') }
    requireThat(['foreground','background'].includes(priority), 'invalid_priority')
    return this.newRun({id:crypto.randomUUID(), version:1, createdAt:Date.now(), priority, timeZone},
      this.bind(modelProfile,mailboxId), message)
  }
  stopPending(t) {
    if (t.attempt) {
      this.store.event('attempt.abandoned',{taskId:t.id,runId:t.runId,messageId:t.attempt,usage:t.lastUsage})
      t.attempt = null
    }
    for (const [index,call] of (t.pending?.calls || []).entries()) {
      if (index < t.pending.index) continue
      const op = this.store.getOp(this.opId(t,index))
      if (op && ['queued','waiting_approval'].includes(op.state)) {
        op.state = 'cancelled'
        delete op.prepared.payload
        op.version++
        this.store.saveOp(op)
      }
      this.store.appendMessage(t,{role:'tool',toolCallId:call.id,toolName:call.name,
        content:JSON.stringify({state:op?.state || 'cancelled',operationId:op?.id})})
    }
    t.pending = null
  }
  steer({taskId,taskVersion,message,modelProfile}) {
    const t = this.store.getTask(taskId)
    checkedVersion(taskVersion,t.version)
    requireThat(t.state !== 'needs_review','reconcile_operation_first',409)
    const binding = this.bind(modelProfile || t.profile,t.mailboxId)
    this.stopPending(t)
    t.version++
    return this.newRun(t,binding,message)
  }
  cancel({taskId,taskVersion}) {
    const t = this.store.getTask(taskId)
    checkedVersion(taskVersion,t.version)
    requireThat(['queued','running','waiting_mail'].includes(t.state),'task_already_closed',409)
    this.stopPending(t)
    t.state = 'cancelled'
    t.version++
    this.store.saveTask(t)
    return taskView(t)
  }
  current(t) {
    const next = this.store.getTask(t.id)
    requireThat(next.runId === t.runId && next.state === 'running','run_superseded',409)
    this.connections.assertEpoch(t.profile.connectionId,t.modelEpoch)
    this.connections.assertEpoch(t.mailboxId,t.mailEpoch)
  }
  opId(t,index) { return 'tool:' + t.runId + ':' + t.step + ':' + index }
  memorySettings() { return this.memory?.state() || {enabled:false,epoch:0} }
  assertMemory(epoch) {
    if (this.memorySettings().epoch !== epoch) throw new ModelError('memory_context_changed',{retryable:true})
  }
  async model(t, signal) {
    requireThat(t.step < LIMITS.steps && t.attempts < LIMITS.attempts,'model_budget_exhausted')
    const stepStart = Date.now()
    const credential = this.connections.modelCredential ? await this.connections.modelCredential(t.profile.connectionId,t.modelEpoch)
      : {apiKey:await this.connections.credential(t.profile.connectionId,t.modelEpoch)}
    this.current(t)
    const memorySettings = this.memorySettings()
    const tools = [...mailToolsFor(this.mail.metadata(t.mailboxId,t.mailEpoch)), ...(memorySettings.enabled ? HISTORY_TOOLS : [])]
    const memoryContext = this.memory?.context(t.id,{maxBytes:6000,mailboxId:t.mailboxId})
    const historyBeforeN = this.store.one('SELECT COALESCE(MAX(n),0)+1 AS n FROM messages WHERE task=?',t.id).n
    const assertCurrent = () => { signal.throwIfAborted(); this.current(t); this.assertMemory(memorySettings.epoch) }
    const projectMessage = message => projectHistoryMessage(message,memorySettings)
    const prepared = this.compaction ? await this.compaction.prepare(t,{
      tools,memoryContext,credential,signal,assertCurrent,projectMessage,memoryEpoch:memorySettings.epoch,
      beforeSummary:() => {
        assertCurrent()
        requireThat(t.attempts < LIMITS.attempts-1 && (t.compactionAttempts || 0) < 2,'compaction_budget_exhausted')
        t.compactionAttempts = (t.compactionAttempts || 0)+1
        t.attempts++
        this.store.tx(() => this.store.saveTask(t,false))
      }
    }) : {messages:buildContext({messages:this.store.contextMessages(t.id).map(projectMessage),tools,memoryContext,
      runStartedAt:t.runStartedAt,timeZone:t.timeZone})}
    const messages = prepared.messages
    assertCurrent()
    const usedHistory = Boolean(memoryContext?.facts?.length || memoryContext?.preferences?.length || memoryContext?.relatedHistory?.length ||
      prepared.containsHistory || prepared.checkpoint?.containsHistory ||
      messages.some(message => message.historyEpoch === memorySettings.epoch))
    const messageId = crypto.randomUUID()
    const started = Date.now()
    t.context = {estimatedBytes:prepared.estimatedBytes ?? null,checkpointVersion:prepared.checkpoint?.version || 0,
      coverage:prepared.coverage || null,warnings:prepared.warnings || []}
    t.attempt = messageId
    t.lastUsage = null
    t.attempts++
    this.store.timing('prepare_model', started-stepStart)
    this.store.tx(() => {
      this.store.saveTask(t,false)
      this.store.event('attempt.started',{taskId:t.id,runId:t.runId,messageId,attempt:t.attempts,step:t.step+1,
        payer:'user_connection', preparationMs:started-stepStart, requestedEffort:t.profile.effort,context:t.context})
    })
    let content = '', buffered = '', lastBatch = started, firstTokenMs = null, finish, usage = null
    const calls = []
    const event = (type,data) => this.store.event(type,{taskId:t.id,runId:t.runId,messageId,...data})
    const flush = () => {
      if (!buffered) return
      event('message.delta',{text:buffered})
      buffered = ''
      lastBatch = Date.now()
    }
    for await (const item of this.stream({profile:t.profile,credential,messages,tools,signal,maxOutputTokens:LIMITS.output})) {
      assertCurrent()
      if (item.type === 'text_delta') {
        firstTokenMs ??= Date.now() - started
        content += item.text
        buffered += item.text
        requireThat(content.length < 64000,'output_limit')
        if (buffered === content || Date.now()-lastBatch >= 30 || buffered.length >= 1000) flush()
      } else if (item.type === 'tool_call') {
        const tool = tools.find(tool => tool.name === item.name)
        requireThat(tool && calls.length + t.toolCount < LIMITS.tools, 'tool_not_allowed_or_budget_exhausted')
        requireThat(typeof item.id === 'string' && item.id.length > 0 && !calls.some(c => c.id === item.id),'invalid_call_id')
        validateTool(tool.inputSchema,item.arguments)
        calls.push({id:item.id,name:item.name,arguments:item.arguments})
      } else if (item.type === 'usage') {
        usage = {inputTokens:item.inputTokens ?? null, outputTokens:item.outputTokens ?? null,
          cacheReadTokens:item.cacheReadTokens ?? null, cacheWriteTokens:item.cacheWriteTokens ?? null,
          reasoningTokens:item.reasoningTokens ?? null, totalTokens:item.totalTokens ?? null}
        t.lastUsage = usage
        this.store.tx(() => this.store.saveTask(t,false))
      } else if (item.type === 'warning') event('model.warning',{code:item.code || 'model_warning'})
      else if (item.type === 'finish') finish = item
    }
    assertCurrent()
    requireThat(finish && ((finish.reason === 'tool_calls') === Boolean(calls.length)),'incomplete_model_step')
    this.store.tx(() => {
      flush()
      t.step++
      t.toolCount += calls.length
      t.attempt = null
      t.failures = 0
      t.error = null
      t.pending = calls.length ? {calls,index:0,historyBeforeN,memoryEpoch:memorySettings.epoch} : null
      this.store.appendMessage(t,{role:'assistant',content,messageId,...(calls.length ? {toolCalls:calls} : {}),
        ...(usedHistory ? {historyEpoch:memorySettings.epoch} : {}),
        ...(finish.providerState ? {providerState:finish.providerState} : {})})
      this.memory?.observe(t.id,messageId,{profile:t.profile,modelEpoch:t.modelEpoch})
      if (firstTokenMs !== null) this.store.timing('model_first_text',firstTokenMs)
      event('attempt.finished',{usage, firstTokenMs, durationMs:Date.now()-started, effectiveEffort:finish.effectiveEffort ?? null})
      if (!calls.length) t.state = 'completed'
      this.store.saveTask(t)
    })
  }
  commitTool(t, call, result, reference = {}) {
    this.store.appendMessage(t,{role:'tool',toolCallId:call.id,toolName:call.name,content:JSON.stringify(result),...reference})
    t.pending.index++
    if (t.pending.index === t.pending.calls.length) t.pending = null
  }
  async tools(t, signal) {
    const {calls,index} = t.pending
    const call = calls[index]
    if (t.pending.memoryEpoch !== undefined && t.pending.memoryEpoch !== this.memorySettings().epoch &&
        !(call.name === 'mail_write' && this.store.getOp(this.opId(t,index)))) {
      // Complete every pending pair with an unavailable result, then ask the
      // model again with current memory. Existing ledger operations still flow
      // through the normal receipt path so an executed action is never forgotten.
      this.store.tx(() => {
        for (const item of calls.slice(index)) this.commitTool(t,item,{error:'memory_context_changed',executed:false})
        this.store.saveTask(t,false)
      })
      return
    }
    if (call.name !== 'mail_write') {
      // DeepSeek Harness batch.ts: dispatch independent reads together; commit in model order.
      const batch = []
      for (const item of calls.slice(index,index + LIMITS.reads)) {
        if (item.name === 'mail_write') break
        batch.push(item)
      }
      const needsMail = batch.some(item => !['history_search','history_read'].includes(item.name))
      const context = needsMail ? await this.mail.context(t.mailboxId,t.mailEpoch) : null
      this.current(t)
      const historyEpoch = this.memorySettings().epoch
      this.assertMemory(t.pending.memoryEpoch ?? historyEpoch)
      const historyScope = {callerTaskId:t.id,mailboxId:t.mailboxId,beforeN:t.pending.historyBeforeN}
      const results = await Promise.all(batch.map(async item => {
        const started = Date.now()
        try {
          signal.throwIfAborted()
          if (item.name === 'history_search') return this.memory.history.search(item.arguments,historyScope)
          if (item.name === 'history_read') return this.memory.history.read(item.arguments,historyScope)
          return await this.read(item.name,item.arguments,{...context,signal})
        }
        catch (error) { return {error:errorCode(error,'read_failed')} }
        finally { this.store.timing(item.name.startsWith('history_') ? 'history_tool' : 'read_tool',Date.now()-started) }
      }))
      this.current(t)
      this.assertMemory(historyEpoch)
      this.store.tx(() => {
        for (const [i,item] of batch.entries()) this.commitTool(t,item,results[i],
          item.name.startsWith('history_') ? {historyEpoch} : {})
        this.store.saveTask(t,false)
      })
      return
    }
    const id = this.opId(t,index)
    let op = this.store.getOp(id)
    if (!op) {
      let plan
      try {
        const {scheduledAt,expectedRevision,expectedProviderVersion,...input} = call.arguments
        plan = await this.mail.plan(input,{mailboxId:t.mailboxId,epoch:t.mailEpoch,signal,scheduledAt,expectedRevision,expectedProviderVersion})
      }
      catch (error) {
        this.current(t)
        this.store.tx(() => {
          this.commitTool(t,call,{error:errorCode(error,'mail_command_invalid')})
          this.store.saveTask(t,false)
        })
        return
      }
      this.current(t)
      this.assertMemory(t.pending.memoryEpoch ?? this.memorySettings().epoch)
      op = this.store.tx(() => this.mail.accept(plan,{id,commandId:id,taskId:t.id}))
    }
    this.store.tx(() => {
      if (op.state === 'unknown') {
        t.waitingOperationId = id
        t.state = 'needs_review'
      } else if (finishedOps.has(op.state)) {
        t.waitingOperationId = null
        this.commitTool(t,call,{operationId:id,status:op.state,receipt:op.receipt})
        if (op.state === 'rejected' || op.state === 'cancelled') { this.stopPending(t); t.state = 'cancelled' }
      } else {
        t.waitingOperationId = id
        t.state = 'waiting_mail'
      }
      this.store.saveTask(t)
    })
  }
  async run(t,signal) {
    try {
      while (t.state === 'running') {
        signal.throwIfAborted()
        this.current(t)
        if (t.pending) await this.tools(t,signal)
        else await this.model(t,signal)
      }
    } catch (error) {
      const latest = this.store.getTask(t.id)
      if (latest.runId !== t.runId || latest.state !== 'running') return
      if (error.code === 'memory_context_changed' && latest.pending) {
        // A read-only preparation may have yielded while memory changed. Close
        // its still-unexecuted calls before retrying with a fresh context.
        this.store.tx(() => this.stopPending(latest))
      }
      const retry = !latest.pending && error.retryable && latest.failures < 2 && latest.attempts < LIMITS.attempts
      this.store.tx(() => {
        if (latest.attempt) this.store.event('attempt.abandoned',{taskId:t.id,runId:t.runId,messageId:latest.attempt,usage:latest.lastUsage})
        latest.attempt = null
        latest.failures++
        latest.state = retry ? 'queued' : 'failed'
        latest.due = retry ? Date.now() + 1000 * 2 ** latest.failures : 0
        latest.error = errorCode(error,signal.aborted ? 'run_timeout' : 'run_failed')
        this.store.saveTask(latest)
      })
    }
  }
}

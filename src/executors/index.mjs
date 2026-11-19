import { identifier, requireThat, errorCode } from '../protocol.mjs'
import { OpenAIHostedClient, hostedError, remoteId } from './client.mjs'
import { hostedProfile, publicExecution, terminalExecutions, sessionBody, matchesSession,
  usageOf, clippedText, artifactType, validateArtifactBytes } from './profile.mjs'

export { OpenAIHostedClient } from './client.mjs'
export { hostedProfile, publicExecution } from './profile.mjs'

const encoder = new TextEncoder()
const STOPPED = 'hosted_execution_stopped'
const LOST = 'hosted_lease_lost'
const active = job => !terminalExecutions.has(job.state) && job.state !== 'cancel_requested'
const canonical = value => JSON.stringify(value,(_,item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item)
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n => n.toString(16).padStart(2,'0')).join('')
const definitiveRejection = error => error.upstreamStatus >= 400 && error.upstreamStatus < 500 && ![408,409].includes(error.upstreamStatus)
const retryable = error => ['hosted_unavailable','hosted_rate_limited','hosted_request_aborted','hosted_storage_unavailable','hosted_secret_unavailable'].includes(error.code)
  || error.status >= 500 && !String(error.code).startsWith('hosted_')
const fileName = value => String(value || 'attachment').replace(/[\x00-\x1f/\\]/g,'_').replace(/^\.+/,'').slice(0,160) || 'attachment'
const assetView = asset => ({id:asset.id,name:asset.name,mimeType:asset.mimeType,size:asset.size,
  sha256:asset.sha256,createdAt:asset.createdAt,...(asset.taskId ? {taskId:asset.taskId} : {})})

function page(value,after) {
  if (!Array.isArray(value?.data) || value.data.length > 100 || typeof value.has_more !== 'boolean'
    || value.has_more && (!remoteId(value.last_id) || value.last_id === after)) throw hostedError('hosted_invalid_page')
  return value
}

/** Durable, account-local child executions. It never executes mail/MCP tools.
 * All timers belong to the parent DO's ExecutionHost: this service only returns
 * nextDue(). Completion hooks must be synchronous writes to this same Store.
 */
export class HostedExecutionService {
  constructor(store,env,{assets,connections,fetcher = fetch,assertCurrent,onComplete,onInvalidated,now = Date.now} = {}) {
    Object.assign(this,{store,env,assets,connections,assertCurrent,onComplete,onInvalidated,now})
    this.busy = false
    const configuredTimeout = Number(env.HOSTED_AGENT_REQUEST_TIMEOUT_MS)
    this.client = new OpenAIHostedClient(env,{fetcher,timeoutMS:Number.isInteger(configuredTimeout)
      && configuredTimeout >= 1000 && configuredTimeout <= 30000 ? configuredTimeout : 20000})
    store.tx(() => {
      store.rows('CREATE TABLE IF NOT EXISTS executor_identity (singleton INTEGER PRIMARY KEY, scope TEXT NOT NULL)')
      store.rows('INSERT OR IGNORE INTO executor_identity VALUES (1,?)',crypto.randomUUID())
      store.rows('CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, parent TEXT NOT NULL, request TEXT NOT NULL UNIQUE, state TEXT NOT NULL, due INTEGER, data TEXT NOT NULL)')
      store.rows('CREATE INDEX IF NOT EXISTS delegation_due ON delegations(due)')
      store.rows('CREATE INDEX IF NOT EXISTS delegation_parent ON delegations(parent)')
      store.rows('CREATE TABLE IF NOT EXISTS delegation_usage (execution TEXT NOT NULL, turn TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(execution,turn))')
    })
    this.scope = store.one('SELECT scope FROM executor_identity WHERE singleton=1').scope
  }

  capabilities() {
    try {
      const profile = hostedProfile(this.env)
      if (!profile.enabled) return {enabled:false,reason:'hosted_disabled'}
      return {enabled:true,provider:'openai-agents',profile:profile.name,model:profile.model,
        effort:profile.effort,timeoutMS:profile.timeoutMS,maxAttachments:profile.maxAttachments,
        maxArtifactBytes:profile.maxArtifactBytes,maxArtifacts:profile.maxArtifacts,
        externalTools:false,networkAccess:false,hardCostCap:false}
    } catch (error) { return {enabled:false,reason:errorCode(error,'hosted_not_configured')} }
  }

  get(id) {
    const row = this.store.one('SELECT data FROM delegations WHERE id=?',identifier(id,'execution_id'))
    requireThat(row,'execution_not_found',404)
    return JSON.parse(row.data)
  }
  inspect(id) { return publicExecution(this.get(id)) }
  find({parentTaskId,runId,runVersion,requestId = 'main'}) {
    const row = this.store.one('SELECT data FROM delegations WHERE request=?',canonical([parentTaskId,runId,runVersion,requestId]))
    return row ? publicExecution(JSON.parse(row.data)) : null
  }
  list({parentTaskId,before = Number.MAX_SAFE_INTEGER,limit = 50} = {}) {
    requireThat(Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,'invalid_execution_page')
    if (parentTaskId !== undefined) identifier(parentTaskId,'task_id')
    const rows = parentTaskId === undefined
      ? this.store.rows('SELECT rowid AS n,data FROM delegations WHERE rowid<? ORDER BY rowid DESC LIMIT ?',before,limit+1)
      : this.store.rows('SELECT rowid AS n,data FROM delegations WHERE parent=? AND rowid<? ORDER BY rowid DESC LIMIT ?',parentTaskId,before,limit+1)
    return {executions:rows.slice(0,limit).map(row => publicExecution(JSON.parse(row.data))),
      nextBefore:rows.length > limit ? rows[limit-1].n : null}
  }

  start({parentTaskId,runId,runVersion,instructions,input = '',attachmentIds = [],profile:requested,
    requestId = 'main',authority = {}}) {
    const profile = hostedProfile(this.env)
    requireThat(profile.enabled,'hosted_disabled',503)
    requireThat(requested === undefined || requested === profile.name,'hosted_profile_not_allowed',403)
    identifier(parentTaskId,'task_id'); identifier(runId,'run_id'); identifier(requestId,'request_id')
    requireThat(Number.isSafeInteger(runVersion) && runVersion >= 1,'invalid_run_version')
    requireThat(typeof instructions === 'string' && instructions.trim() && encoder.encode(instructions).length <= 16000,'invalid_execution_instructions')
    requireThat(typeof input === 'string' || input && typeof input === 'object' && !Array.isArray(input),'invalid_execution_input')
    requireThat(Array.isArray(attachmentIds) && attachmentIds.length <= profile.maxAttachments
      && new Set(attachmentIds).size === attachmentIds.length,'invalid_execution_attachments')
    attachmentIds.forEach(id => identifier(id,'asset_id'))
    requireThat(authority && typeof authority === 'object' && !Array.isArray(authority)
      && encoder.encode(JSON.stringify(authority)).length <= 8192,'invalid_execution_authority')
    const material = {instructions,input,attachmentIds}
    requireThat(encoder.encode(JSON.stringify(material)).length <= profile.maxInputBytes,'execution_input_too_large',413)
    const signature = canonical({material,authority,profile:profile.name})
    const request = canonical([parentTaskId,runId,runVersion,requestId])
    return this.store.tx(() => {
      const prior = this.store.one('SELECT data FROM delegations WHERE request=?',request)
      if (prior) {
        const old = JSON.parse(prior.data)
        requireThat(old.signature === signature,'execution_request_conflict',409)
        return publicExecution(old)
      }
      const parent = this.store.getTask(parentTaskId)
      requireThat(parent.runId === runId && parent.version === runVersion
        && !['completed','cancelled','failed'].includes(parent.state),'execution_parent_changed',409)
      // Unconfirmed remote work still occupies admission capacity; a client
      // cannot bypass the limit by cancelling a session whose ID was lost.
      const count = this.store.one('SELECT COUNT(*) AS n FROM delegations WHERE due IS NOT NULL').n
      requireThat(count < profile.maxOpen,'hosted_capacity_exceeded',429)
      const now = this.now()
      const job = {id:crypto.randomUUID(),intent:crypto.randomUUID(),parentTaskId,runId,runVersion,requestId,request,signature,
        authority:structuredClone(authority),profile,input:structuredClone(material),state:'prepared',due:now,
        createdAt:now,updatedAt:now,deadline:now+profile.timeoutMS,uploads:[],submitted:false,
        cleanupStatus:'pending',deliveredAt:null,lease:null,retries:0}
      this.save(job,true)
      return publicExecution(job)
    })
  }

  save(job,announce = false) {
    job.updatedAt = this.now()
    this.store.rows('INSERT INTO delegations VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      job.id,job.parentTaskId,job.request,job.state,job.due ?? null,JSON.stringify(job))
    if (announce) this.store.event('execution.updated',publicExecution(job))
    return job
  }
  change(id,fn,lease,announce = false) {
    return this.store.tx(() => {
      const job = this.get(id)
      if (lease !== undefined && job.lease !== lease) throw hostedError(LOST)
      fn(job)
      return this.save(job,announce)
    })
  }
  cancel(id,reason = 'user_cancelled') {
    requireThat(typeof reason === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(reason),'invalid_cancel_reason')
    return publicExecution(this.stop(id,reason))
  }
  cancelForTask(parentTaskId,reason = 'parent_changed') {
    identifier(parentTaskId,'task_id')
    const rows = this.store.rows("SELECT id FROM delegations WHERE parent=? AND state NOT IN ('completed','failed','cancelled','unknown')",parentTaskId)
    return rows.map(row => this.cancel(row.id,reason))
  }
  cancelAll(reason = 'account_deleted') {
    return this.store.rows("SELECT id FROM delegations WHERE state NOT IN ('completed','failed','cancelled','unknown')")
      .map(row => this.cancel(row.id,reason))
  }
  cleanupStatus() {
    const row = this.store.one(`SELECT COUNT(*) AS pending,
      COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) AS unknown
      FROM delegations WHERE due IS NOT NULL`)
    return {...row,active:this.busy ? 1 : 0,complete:row.pending === 0 && !this.busy}
  }
  retryCleanup() {
    for (const {id} of this.store.rows('SELECT id FROM delegations WHERE due IS NOT NULL')) {
      this.change(id,job => { job.due = this.now() })
    }
  }
  // Account lifecycle calls this only after its local execution barrier drains.
  // Remote reconciliation needs opaque IDs and upload hashes, never task text.
  redactAll() {
    requireThat(!this.busy,'execution_cleanup_busy',409)
    requireThat(!this.store.one("SELECT 1 FROM delegations WHERE state IN ('prepared','submitting','running','collecting') LIMIT 1"),'execution_not_cancelled',409)
    for (const {id} of this.store.rows('SELECT id FROM delegations')) this.change(id,job => {
      delete job.input; delete job.signature; delete job.result
      job.discarded = true
      if (job.collection) job.collection = {artifacts:(job.collection.artifacts || []).map(item => ({
        remoteId:item.remoteId,removed:!!item.removed,...(item.asset ? {asset:{id:item.asset.id}} : {})
      }))}
      for (const file of job.uploads) { delete file.name; delete file.path }
    })
  }
  erase() {
    requireThat(this.cleanupStatus().complete,'execution_cleanup_pending',409)
    this.store.tx(() => {
      this.store.rows('DELETE FROM delegation_usage')
      this.store.rows('DELETE FROM delegations')
    })
  }
  stop(id,reason,outcome = 'cancelled') {
    return this.change(id,job => {
      if (terminalExecutions.has(job.state)) return
      job.state = 'cancel_requested'; job.stopReason = reason; job.stopState = outcome; job.due = this.now()
      job.stopRequestedAt ??= this.now()
    },undefined,true)
  }
  recover() {
    // Never turn a sent POST into a fresh POST after reconstruction.
    for (const {id} of this.store.rows('SELECT id FROM delegations WHERE due IS NOT NULL')) {
      this.change(id,job => { job.lease = null })
    }
  }
  nextDue() { return this.store.one('SELECT MIN(due) AS due FROM delegations').due }

  async guard(id,lease,{attachments = false} = {}) {
    let job = this.get(id)
    if (job.lease !== lease) throw hostedError(LOST)
    if (!active(job)) throw hostedError(STOPPED)
    if (this.now() >= job.deadline) {
      this.stop(id,'hosted_deadline_exceeded','failed'); throw hostedError(STOPPED)
    }
    if (this.env.HOSTED_AGENT_ENABLED !== 'true') {
      this.stop(id,'hosted_disabled'); throw hostedError(STOPPED)
    }
    try {
      if (this.assertCurrent) {
        if (await this.assertCurrent(job) === false) throw hostedError('execution_parent_changed')
      } else {
        const parent = this.store.getTask(job.parentTaskId)
        requireThat(parent.runId === job.runId && parent.version === job.runVersion
          && !['completed','cancelled','failed'].includes(parent.state),'execution_parent_changed',409)
      }
      if (attachments && job.input.attachmentIds.length) {
        requireThat(this.assets,'assets_unavailable',503)
        await this.assets.validateRefs?.(job.input.attachmentIds)
      }
    } catch (error) {
      this.stop(id,errorCode(error,'execution_authority_changed'))
      throw hostedError(STOPPED)
    }
    job = this.get(id)
    if (job.lease !== lease) throw hostedError(LOST)
    if (!active(job)) throw hostedError(STOPPED)
    return job
  }

  async runNext(signal) {
    if (this.busy) return false
    const first = this.store.one('SELECT id FROM delegations WHERE due IS NOT NULL AND due<=? ORDER BY due,rowid LIMIT 1',this.now())
    if (!first) return false
    this.busy = true
    const lease = crypto.randomUUID()
    this.change(first.id,job => { job.lease = lease })
    try {
      let job = this.get(first.id)
      if (terminalExecutions.has(job.state)) {
        this.deliver(job.id,lease)
        await this.cleanup(job.id,lease,signal)
      } else if (job.state === 'cancel_requested') await this.cancelStep(job.id,lease,signal)
      else {
        job = await this.guard(job.id,lease)
        if (job.state === 'prepared') await this.prepare(job.id,lease,signal)
        else if (job.state === 'submitting') await this.reconcile(job.id,lease,signal)
        else if (job.state === 'running') await this.poll(job.id,lease,signal)
        else if (job.state === 'collecting') await this.collect(job.id,lease,signal)
      }
    } catch (error) {
      if (![STOPPED,LOST].includes(error.code)) this.failedStep(first.id,lease,error)
    } finally {
      try { this.change(first.id,job => { job.lease = null },lease) } catch (error) { if (error.code !== LOST) throw error }
      this.busy = false
    }
    return true
  }

  defer(id,lease,delay,error) {
    this.change(id,job => {
      job.due = this.now()+delay
      if (error) { job.lastError = errorCode(error,'hosted_unavailable'); job.retries++ }
    },lease)
  }
  failedStep(id,lease,error) {
    const job = this.get(id)
    if (job.lease !== lease) return
    if (job.state === 'cancel_requested' && job.stopRequestedAt !== undefined && this.now() >= job.stopRequestedAt+60000) {
      this.finish(id,'unknown','hosted_cancel_unconfirmed',lease)
      return
    }
    if (terminalExecutions.has(job.state) || job.state === 'cancel_requested'
      || job.submitted && !job.sessionId || job.uploads.some(file => file.state === 'uploading')) {
      this.defer(id,lease,Math.max(1000,error.retryAfterMS || Math.min(60000,3000*2**Math.min(job.retries,4))),error)
      return
    }
    if (retryable(error) && this.now() < job.deadline) {
      this.defer(id,lease,Math.max(1000,error.retryAfterMS || Math.min(30000,3000*2**Math.min(job.retries,4))),error)
      return
    }
    if (job.sessionId) this.stop(id,errorCode(error,'hosted_task_failed'),'failed')
    else this.finish(id,'failed',errorCode(error,'hosted_task_failed'),lease)
  }

  async prepare(id,lease,signal) {
    let job = await this.guard(id,lease,{attachments:true})
    const unfinished = job.uploads.find(file => file.state !== 'uploaded')
    if (unfinished?.state === 'uploading') { await this.recoverUpload(id,unfinished.assetId,lease,signal); return }
    if (job.uploads.length < job.input.attachmentIds.length || unfinished) {
      const assetId = unfinished?.assetId ?? job.input.attachmentIds[job.uploads.length]
      requireThat(this.assets?.bytes,'assets_unavailable',503)
      const {asset,bytes} = await this.assets.bytes(assetId,{maxBytes:job.profile.maxAttachmentBytes})
      job = await this.guard(id,lease,{attachments:true})
      requireThat(bytes instanceof Uint8Array && bytes.length <= job.profile.maxAttachmentBytes,'hosted_attachment_too_large',413)
      const digest = await hash(bytes)
      await this.guard(id,lease)
      if (asset.sha256) requireThat(digest === asset.sha256,'hosted_attachment_corrupt',422)
      const previous = job.uploads.find(file => file.assetId === assetId)
      if (previous) requireThat(previous.sha256 === digest && previous.size === bytes.length,'hosted_attachment_changed',409)
      const size = job.uploads.filter(file => file.assetId !== assetId).reduce((sum,file) => sum+file.size,0)+bytes.length
      requireThat(size <= job.profile.maxTotalInputBytes,'hosted_attachment_too_large',413)
      const name = fileName(asset.name)
      const file = previous ?? {assetId,name,size:bytes.length,sha256:digest,
        path:`/workspace/inputs/${job.uploads.length}-${name}`,
        filename:`maco-${job.intent}-${job.uploads.length}.${name.split('.').at(-1).replace(/[^A-Za-z0-9]/g,'').slice(0,16) || 'bin'}`}
      let uploaded
      try { uploaded = await this.client.upload(bytes,file.filename,signal,{
        beforeDispatch:() => this.guard(id,lease,{attachments:true}),
        onDispatch:() => this.change(id,current => {
          if (!active(current)) throw hostedError(STOPPED)
          const found = current.uploads.find(item => item.assetId === assetId)
          if (!found) current.uploads.push(file)
          Object.assign(found ?? file,{state:'uploading',startedAt:this.now(),after:null})
        },lease),
      }) }
      catch (error) {
        if (definitiveRejection(error) || error.beforeDispatch) this.change(id,current => {
          const file = current.uploads.find(item => item.assetId === assetId)
          if (file?.state === 'uploading') file.state = 'prepared'
        },lease)
        throw error
      }
      if (!remoteId(uploaded.id)) throw hostedError('hosted_invalid_response')
      // Record an accepted upload even when cancellation arrived during I/O.
      this.change(id,current => {
        Object.assign(current.uploads.find(item => item.assetId === assetId),{fileId:uploaded.id,state:'uploaded'})
        current.due = this.now()
      },lease)
      return
    }
    job = await this.guard(id,lease,{attachments:true})
    const body = sessionBody(job,this.scope)
    let session
    try { session = await this.client.create(body,signal,{
      beforeDispatch:() => this.guard(id,lease,{attachments:true}),
      onDispatch:() => this.change(id,current => {
        if (!active(current)) throw hostedError(STOPPED)
        current.state = 'submitting'; current.submitted = true; current.submittedAt = this.now(); current.due = this.now()+current.profile.pollMS
      },lease,true),
    }) }
    catch (error) {
      if (definitiveRejection(error) || error.beforeDispatch) this.change(id,current => {
        current.submitted = false
        if (current.state === 'submitting') current.state = 'prepared'
      },lease)
      throw error
    }
    this.attach(id,session,lease)
  }

  attach(id,session,lease) {
    this.change(id,job => {
      requireThat(remoteId(session?.id) && matchesSession(session,job,this.scope),'hosted_session_mismatch',502)
      requireThat(!job.sessionId || job.sessionId === session.id,'hosted_session_mismatch',502)
      job.sessionId = session.id
      if (remoteId(session.environment?.id)) job.environmentId = session.environment.id
      if (job.state === 'submitting') job.state = 'running'
      job.due = this.now()
      delete job.scanAfter
    },lease,true)
  }

  async recoverUpload(id,assetId,lease,signal) {
    const job = this.get(id),file = job.uploads.find(item => item.assetId === assetId)
    const listing = page(await this.client.files({after:file.after,signal}),file.after)
    const match = listing.data.find(item => item.filename === file.filename)
    if (match) {
      requireThat(remoteId(match.id) && (match.bytes === undefined || match.bytes === file.size),'hosted_upload_mismatch',502)
      this.change(id,current => {
        Object.assign(current.uploads.find(item => item.assetId === assetId),{fileId:match.id,state:'uploaded',after:null})
        current.due = this.now()
      },lease)
    } else this.change(id,current => {
      const upload = current.uploads.find(item => item.assetId === assetId)
      upload.after = listing.has_more ? listing.last_id : null
      // Upload copies request a one-hour provider TTL. Retain the evidence for
      // two hours before treating an unlocated copy as expired during cleanup.
      if (this.now() > upload.startedAt+2*3600000 && !active(current)) upload.state = 'deleted'
      current.due = this.now()+(listing.has_more ? 1000 : active(current) ? current.profile.pollMS : 60000)
    },lease)
  }

  async reconcile(id,lease,signal) {
    const job = this.get(id)
    const listing = page(await this.client.list({after:job.scanAfter,order:'desc',signal}),job.scanAfter)
    const matches = listing.data.filter(session => matchesSession(session,job,this.scope))
    requireThat(matches.length <= 1,'hosted_duplicate_sessions',502)
    if (matches.length) { this.attach(id,matches[0],lease); return }
    this.change(id,current => {
      const older = listing.data.some(session => Number.isFinite(session.created_at) && session.created_at*1000 < current.submittedAt-60000)
      current.scanAfter = listing.has_more && !older ? listing.last_id : null
      if (!current.scanAfter) current.scans = (current.scans || 0)+1
      current.due = this.now()+(current.scanAfter ? 1000 : terminalExecutions.has(current.state) ? 60000 : current.profile.pollMS)
    },lease)
    const current = this.get(id)
    if (!terminalExecutions.has(current.state) && (this.now() >= current.deadline
      || current.state === 'cancel_requested' && current.scans >= 3)) {
      this.finish(id,'unknown','hosted_submission_unconfirmed',lease)
    }
  }

  sessionValid(session,job) {
    requireThat(session && session.id === job.sessionId && matchesSession(session,job,this.scope),'hosted_session_mismatch',502)
  }
  recordUsage(id,turn,lease) {
    const usage = usageOf(turn)
    this.change(id,job => {
      job.turnId = turn.id
      if (usage.available || !job.usage?.available) job.usage = usage
      if (remoteId(turn.id)) {
        const prior = this.store.one('SELECT data FROM delegation_usage WHERE execution=? AND turn=?',id,turn.id)
        if (prior && !usage.available) return
        const data = JSON.stringify(usage)
        this.store.rows('INSERT INTO delegation_usage VALUES (?,?,?) ON CONFLICT(execution,turn) DO UPDATE SET data=excluded.data',id,turn.id,data)
        if (prior?.data !== data) this.store.event('execution.usage',{executionId:id,taskId:job.parentTaskId,usage})
      }
    },lease)
  }
  async poll(id,lease,signal) {
    let job = await this.guard(id,lease,{attachments:true})
    const beforeDispatch = () => this.guard(id,lease,{attachments:true})
    const session = await this.client.retrieve(job.sessionId,signal,{beforeDispatch})
    job = await this.guard(id,lease)
    if (!session) {
      this.change(id,current => { current.sessionDeleted = true },lease)
      this.finish(id,'failed','hosted_session_missing',lease); return
    }
    this.sessionValid(session,job)
    if ((session.required_actions || []).length) {
      this.stop(id,'hosted_action_not_allowed','failed'); return
    }
    if (session.status === 'failed') { this.finish(id,'failed','hosted_task_failed',lease); return }
    if (session.status !== 'idle') { this.defer(id,lease,job.profile.pollMS); return }
    const turns = page(await this.client.turns(job.sessionId,{order:'desc',limit:20,signal,beforeDispatch}))
    job = await this.guard(id,lease)
    const turn = turns.data.find(value => !value.subagent_id)
    if (!turn || ['queued','waiting','in_progress'].includes(turn.status)) { this.defer(id,lease,job.profile.pollMS); return }
    requireThat(remoteId(turn.id) && (!turn.session_id || turn.session_id === job.sessionId),'hosted_turn_mismatch',502)
    this.recordUsage(id,turn,lease)
    this.change(id,current => { current.remoteStopped = true },lease)
    if (turn.status !== 'completed') {
      this.finish(id,turn.status === 'cancelled' ? 'cancelled' : 'failed',
        turn.status === 'cancelled' ? 'hosted_remote_cancelled' : 'hosted_task_failed',lease)
      return
    }
    this.change(id,current => {
      current.state = 'collecting'; current.collection = {phase:'items',texts:[],seen:[],pages:0,textTruncated:false,skipped:[],artifacts:[]}
      current.due = this.now()
    },lease,true)
  }

  async collect(id,lease,signal) {
    let job = await this.guard(id,lease,{attachments:true})
    const beforeDispatch = () => this.guard(id,lease,{attachments:true})
    if (job.collection.phase === 'items') {
      const items = page(await this.client.items(job.sessionId,job.turnId,{after:job.collection.after,signal,beforeDispatch}),job.collection.after)
      job = await this.guard(id,lease)
      this.change(id,current => {
        const collection = current.collection
        for (const item of items.data) {
          if (!remoteId(item.id) || collection.seen.includes(item.id)) continue
          if (item.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer' && item.status === 'completed') {
            requireThat(Array.isArray(item.content),'hosted_invalid_output',502)
            const text = item.content.filter(part => part.type === 'output_text').map(part => {
              requireThat(typeof part.text === 'string','hosted_invalid_output',502); return part.text
            }).join('')
            const projected = clippedText([...collection.texts,text].filter(Boolean).join('\n'),current.profile.maxTextBytes)
            collection.texts = [projected.text]
            collection.textTruncated ||= projected.truncated
          }
          collection.seen.push(item.id)
        }
        collection.pages++
        if (items.has_more && collection.pages < 20) collection.after = items.last_id
        else { collection.phase = 'artifacts'; collection.textTruncated ||= items.has_more }
        current.due = this.now()
      },lease)
      return
    }
    if (job.collection.phase === 'artifacts') {
      const artifacts = page(await this.client.artifacts(job.sessionId,{signal,beforeDispatch}))
      job = await this.guard(id,lease)
      this.change(id,current => {
        const collection = current.collection
        let total = 0
        collection.artifactsTruncated = artifacts.has_more
        for (const artifact of artifacts.data) {
          requireThat(remoteId(artifact.id) && artifact.session_id === current.sessionId
            && Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0,'hosted_artifact_mismatch',502)
          if (artifact.turn_id !== current.turnId) continue
          const type = artifactType(artifact.path)
          const reason = !type ? 'unsupported_artifact_type' : artifact.size_bytes > current.profile.maxArtifactBytes
            || total+artifact.size_bytes > current.profile.maxTotalArtifactBytes ? 'artifact_too_large'
              : collection.artifacts.length >= current.profile.maxArtifacts ? 'artifact_count_limit' : null
          if (reason) {
            collection.artifactsTruncated = true
            if (collection.skipped.length < 16) collection.skipped.push({name:type?.name || 'unsupported output',reason})
            continue
          }
          requireThat(!collection.artifacts.some(value => value.remoteId === artifact.id),'hosted_artifact_mismatch',502)
          total += artifact.size_bytes
          collection.artifacts.push({remoteId:artifact.id,size:artifact.size_bytes,path:artifact.path,...type})
        }
        collection.phase = 'download'; current.due = this.now()
      },lease)
      return
    }
    const artifact = job.collection.artifacts.find(value => !value.asset)
    if (artifact) {
      requireThat(this.assets?.put,'assets_unavailable',503)
      const bytes = await this.client.artifactBytes(job.sessionId,artifact.remoteId,Math.min(artifact.size,job.profile.maxArtifactBytes),signal,{beforeDispatch})
      await this.guard(id,lease)
      requireThat(bytes.length === artifact.size,'hosted_artifact_corrupt',502)
      validateArtifactBytes(bytes,artifact)
      const sha256 = await hash(bytes)
      await this.guard(id,lease)
      let asset
      try {
        asset = await this.assets.put({name:artifact.name,mimeType:artifact.mimeType,body:bytes,size:bytes.length,
          expectedSha256:sha256,taskId:job.parentTaskId,
          idempotencyKey:`executor:${job.id}:${artifact.remoteId}`,
          source:{kind:'executor',taskId:job.parentTaskId,executionId:job.id,artifactId:artifact.remoteId}})
      } catch (error) {
        if ([400,403,404,409,413,422].includes(error.status)) throw error
        throw hostedError('hosted_storage_unavailable')
      }
      try {
        this.change(id,current => {
          const value = current.collection.artifacts.find(item => item.remoteId === artifact.remoteId)
          value.asset = assetView(asset); value.sha256 = sha256; current.due = this.now()
        },lease)
      } catch (error) {
        const fresh = this.get(id)
        if (fresh.state === 'cancel_requested' || terminalExecutions.has(fresh.state) && fresh.state !== 'completed') await this.assets.remove(asset.id)
        throw error
      }
      await this.guard(id,lease)
      return
    }
    job = await this.guard(id,lease,{attachments:true})
    const text = job.collection.texts.join('\n')
    requireThat(text.trim() || job.collection.artifacts.length,'hosted_empty_result',502)
    const result = {text,artifacts:job.collection.artifacts.map(value => value.asset),
      coverage:{textTruncated:job.collection.textTruncated,artifactsTruncated:!!job.collection.artifactsTruncated,
        skipped:job.collection.skipped}}
    this.finish(id,'completed',null,lease,result)
  }

  finish(id,state,error,lease,result) {
    this.change(id,job => {
      if (terminalExecutions.has(job.state)) return
      if (state === 'completed' && job.state === 'cancel_requested') throw hostedError(STOPPED)
      job.state = state; job.terminalAt = this.now(); job.due = this.now()+1000
      if (error) job.error = error
      if (result) job.result = result
      else delete job.result
      job.cleanupStatus = 'pending'
    },lease)
    this.deliver(id,lease)
  }

  deliver(id,lease) {
    this.store.tx(() => {
      const job = this.get(id)
      if (job.lease !== lease) throw hostedError(LOST)
      if (!terminalExecutions.has(job.state) || job.deliveredAt) return
      let current = true,reason = 'execution_authority_changed'
      try {
        if (this.assertCurrent) {
          const result = this.assertCurrent(job)
          requireThat(!result?.then,'async_execution_completion_guard',500)
          current = result !== false
        } else {
          const parent = this.store.getTask(job.parentTaskId)
          current = parent.runId === job.runId && parent.version === job.runVersion && !['cancelled','failed'].includes(parent.state)
        }
      } catch (error) {
        if (error.code === 'async_execution_completion_guard') throw error
        current = false
        reason = errorCode(error,'execution_authority_changed')
      }
      if (current) {
        job.deliveredAt = this.now() || 1
        const value = this.onComplete?.(publicExecution(job))
        requireThat(!value?.then,'async_execution_completion_hook',500)
      } else {
        job.discarded = true
        job.invalidationReason = reason
        delete job.result
        if (job.state === 'completed') { job.state = 'cancelled'; job.error = reason }
        // Report only a content-free authority failure. The parent decides
        // whether this still matches its current waiting run; cancelled/steered
        // runs must not be revived. This receipt shares its SQLite transaction.
        job.deliveredAt = this.now() || 1
        const value = this.onInvalidated?.(publicExecution(job),reason)
        requireThat(!value?.then,'async_execution_invalidation_hook',500)
      }
      job.deliveredAt = this.now() || 1
      this.save(job,true)
    })
  }

  async cancelStep(id,lease,signal) {
    const job = this.get(id)
    if (!job.sessionId) {
      if (job.submitted) { await this.reconcile(id,lease,signal); return }
      this.finish(id,job.stopState || 'cancelled',job.stopReason || 'user_cancelled',lease); return
    }
    const session = await this.client.retrieve(job.sessionId,signal)
    if (!session) {
      this.change(id,current => { current.sessionDeleted = true },lease)
      this.finish(id,job.stopState || 'cancelled',job.stopReason,lease); return
    }
    this.sessionValid(session,job)
    if (!['idle','failed'].includes(session.status)) {
      await this.client.cancel(job.sessionId,'cancel:'+job.intent,signal)
      // HTTP 202 only acknowledges the cancel input; retrieve again on the next wake.
      if (job.stopRequestedAt !== undefined && this.now() >= job.stopRequestedAt+60000) this.finish(id,'unknown','hosted_cancel_unconfirmed',lease)
      else this.defer(id,lease,job.profile.pollMS)
      return
    }
    this.change(id,current => { current.remoteStopped = true },lease)
    this.finish(id,job.stopState || 'cancelled',job.stopReason || 'user_cancelled',lease)
  }

  async cleanup(id,lease,signal) {
    let job = this.get(id)
    if (job.submitted && !job.sessionId) { await this.reconcile(id,lease,signal); return }
    if (job.sessionId && !job.sessionDeleted) {
      if (!job.remoteStopped) {
        const session = await this.client.retrieve(job.sessionId,signal)
        if (!session) this.change(id,current => { current.sessionDeleted = true; current.due = this.now() },lease)
        else {
          this.sessionValid(session,job)
          if (!['idle','failed'].includes(session.status)) {
            await this.client.cancel(job.sessionId,'cancel:'+job.intent,signal)
            this.defer(id,lease,job.state === 'unknown' ? 60000 : job.profile.pollMS)
          } else this.change(id,current => { current.remoteStopped = true; current.due = this.now() },lease)
        }
        return
      }
      if (!job.usageReconciled) {
        try {
          const turns = page(await this.client.turns(job.sessionId,{order:'desc',limit:20,signal}))
          const turn = turns.data.find(value => !value.subagent_id && (!job.turnId || value.id === job.turnId))
          if (turn && remoteId(turn.id) && ['completed','failed','cancelled'].includes(turn.status)
            && (!turn.session_id || turn.session_id === job.sessionId)) this.recordUsage(id,turn,lease)
        } catch (error) {
          if (signal?.aborted) throw error
          // A missing final usage report is explicitly incomplete, never zero.
          this.change(id,current => { current.usage ||= {available:false,incomplete:true} },lease)
        }
        this.change(id,current => { current.usageReconciled = true; current.due = this.now() },lease)
        return
      }
      await this.client.remove(job.sessionId,signal)
      this.change(id,current => { current.sessionDeleted = true; current.due = this.now() },lease)
      return
    }
    const upload = job.uploads.find(file => file.state !== 'deleted')
    if (upload) {
      if (upload.fileId) {
        await this.client.removeFile(upload.fileId,signal)
        this.change(id,current => {
          current.uploads.find(file => file.assetId === upload.assetId).state = 'deleted'; current.due = this.now()
        },lease)
      } else if (upload.state === 'uploading') await this.recoverUpload(id,upload.assetId,lease,signal)
      else this.change(id,current => {
        current.uploads.find(file => file.assetId === upload.assetId).state = 'deleted'; current.due = this.now()
      },lease)
      return
    }
    if (job.state !== 'completed' || job.discarded) {
      const artifact = job.collection?.artifacts.find(value => value.asset && !value.removed)
      if (artifact) {
        await (this.assets.retire ? this.assets.retire(artifact.asset.id) : this.assets.remove(artifact.asset.id))
        this.change(id,current => {
          current.collection.artifacts.find(value => value.remoteId === artifact.remoteId).removed = true; current.due = this.now()
        },lease)
        return
      }
    }
    this.change(id,current => {
      current.cleanupStatus = 'completed'; current.due = null; current.lease = null
      delete current.input; delete current.collection
    },lease,true)
  }
}

import {requireThat, checkedVersion, errorCode} from '../protocol.mjs'
import {streamStep} from '../model/index.mjs'
import {validateTool} from '../tool-policy.mjs'
import {withDeadline} from '../deadline.mjs'
import {explicitPreferences, extractionPrompt, mayContainPreference, preferenceTool, safePersonalText} from './extract.mjs'
import {HistoryService} from '../history/index.mjs'

const DAY = 86_400_000
const schema = [
  `CREATE TABLE IF NOT EXISTS personal_memory (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL,
    version INTEGER NOT NULL, source TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_state (singleton INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_observed (messageId TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory_excluded_sources (messageId TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS memory_proposals (
    id TEXT PRIMARY KEY, sourceMessageId TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
    version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(sourceMessageId,key))`,
  `CREATE TABLE IF NOT EXISTS memory_jobs (
    id TEXT PRIMARY KEY, sourceN INTEGER NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL,
    attempts INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS due_memory_jobs ON memory_jobs(state,due)`,
  `CREATE TABLE IF NOT EXISTS memory_daily_budget (day INTEGER PRIMARY KEY, attempts INTEGER NOT NULL)`
]

function memoryKey(key) {
  requireThat(typeof key === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(key),'invalid_memory_key')
  requireThat(!/(?:password|credential|secret|api[_-]?key|access[_-]?token|permission|approval|authorization|system[_-]?prompt)/i.test(key),'memory_key_not_allowed')
  requireThat(!/^(?:model|provider|payer|tool|system|policy|connection)(?:[._-]|$)/i.test(key),'memory_key_not_allowed')
  return key
}
function memoryValue(value) {
  requireThat(safePersonalText(value) && value.trim().length <= 500,'invalid_memory_value')
  return value.trim()
}
function view(row) {
  if (!row) return null
  return {...row,source:JSON.parse(row.source)}
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
const utf8 = new TextEncoder()

// One instance per trusted user DO. This module never accepts an owner ID from
// tools or model output, and it has no global or cross-DO memory cache.
export class MemoryService {
  constructor(store,{connections,stream = streamStep,now = Date.now} = {}) {
    Object.assign(this,{store,connections,stream,now})
    store.tx(() => {
      for (const sql of schema) store.rows(sql)
      store.rows('INSERT OR IGNORE INTO memory_state VALUES (1,?)',JSON.stringify({
        enabled:true, extractionMode:'explicit', version:1, epoch:1, historyCursor:0, historyFloor:0, forgetBeforeN:0
      }))
    })
    this.history=new HistoryService(store,{state:()=>this.state(),saveState:state=>this.saveState(state)})
  }
  state() { return JSON.parse(this.store.one('SELECT data FROM memory_state WHERE singleton=1').data) }
  saveState(state) { this.store.rows('UPDATE memory_state SET data=? WHERE singleton=1',JSON.stringify(state)) }
  settings() {
    const {enabled,extractionMode,version} = this.state()
    return {enabled,extractionMode,version}
  }
  configure({enabled,extractionMode,expectedVersion}) {
    return this.store.tx(() => {
      const state=this.state()
      checkedVersion(expectedVersion,state.version)
      requireThat(enabled === undefined || typeof enabled === 'boolean','invalid_memory_setting')
      requireThat(extractionMode === undefined || ['explicit','model_proposals'].includes(extractionMode),'invalid_memory_mode')
      if (enabled === true && !state.enabled) {
        state.historyFloor = this.store.one('SELECT COALESCE(MAX(n),0) AS n FROM messages').n
        state.historyCursor = Math.max(state.historyCursor,state.historyFloor)
      }
      state.enabled = enabled ?? state.enabled
      state.extractionMode = extractionMode ?? state.extractionMode
      state.version++
      state.epoch++
      this.saveState(state)
      this.store.rows("UPDATE memory_jobs SET state='cancelled' WHERE state IN ('queued','running')")
      this.store.event('memory.settings',{settings:this.settings()})
      return this.settings()
    })
  }
  get(key) { return view(this.store.one('SELECT * FROM personal_memory WHERE key=?',memoryKey(key))) }
  list({includeDeleted=false,limit=200} = {}) {
    requireThat(Number.isSafeInteger(limit) && limit>0 && limit<=200,'invalid_memory_limit')
    const filter=includeDeleted ? '' : "WHERE status='active'"
    return {settings:this.settings(),memories:this.store.rows(`SELECT * FROM personal_memory ${filter} ORDER BY updatedAt DESC,key LIMIT ?`,limit).map(view),
      proposals:this.store.rows("SELECT data FROM memory_proposals WHERE status='proposed' ORDER BY rowid DESC LIMIT 30").map(r=>JSON.parse(r.data))}
  }
  upsert({key,kind='preference',value,expectedVersion,restore=false}) {
    memoryKey(key); memoryValue(value)
    requireThat(['fact','preference'].includes(kind),'invalid_memory_kind')
    return this.store.tx(() => {
      const old=this.get(key)
      if (old) checkedVersion(expectedVersion,old.version)
      else requireThat(expectedVersion === undefined || expectedVersion === 0,'stale_version',409)
      requireThat(!old || old.status !== 'deleted' || restore === true,'memory_deleted_requires_restore',409)
      return this.write({key,kind,value:value.trim(),source:{type:'user_edit'},old})
    })
  }
  write({key,kind,value,source,old}) {
    requireThat(old?.status==='active' || this.store.one("SELECT COUNT(*) AS count FROM personal_memory WHERE status='active'").count<200,'memory_capacity_reached',429)
    const at=this.now(),next={key,kind,value,status:'active',version:(old?.version || 0)+1,source,
      createdAt:old?.createdAt ?? at,updatedAt:at}
    this.store.rows(`INSERT INTO personal_memory VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      kind=excluded.kind,value=excluded.value,status=excluded.status,version=excluded.version,source=excluded.source,updatedAt=excluded.updatedAt`,
      next.key,next.kind,next.value,next.status,next.version,JSON.stringify(next.source),next.createdAt,next.updatedAt)
    this.store.event('memory.updated',{memory:next})
    return next
  }
  remove({key,expectedVersion}) {
    return this.store.tx(() => {
      const old=this.get(key)
      requireThat(old,'memory_not_found',404); checkedVersion(expectedVersion,old.version)
      requireThat(old.status==='active','memory_already_deleted',409)
      if (old.source.messageId) this.store.rows('INSERT OR IGNORE INTO memory_excluded_sources VALUES (?)',old.source.messageId)
      this.store.rows('INSERT OR IGNORE INTO memory_excluded_sources SELECT sourceMessageId FROM memory_proposals WHERE key=?',key)
      // Keep only a key tombstone, never the deleted value or evidence. The
      // extraction watermark also invalidates queued jobs based on old history.
      this.store.rows("UPDATE personal_memory SET status='deleted',value='',source='{}',version=version+1,updatedAt=? WHERE key=?",this.now(),key)
      this.store.rows("UPDATE memory_proposals SET status='rejected',version=version+1,data=json_remove(data,'$.value','$.evidence') WHERE key=?",key)
      const state=this.state()
      state.forgetBeforeN=this.store.one('SELECT COALESCE(MAX(n),0) AS n FROM messages').n
      state.epoch++
      this.saveState(state)
      this.store.rows("UPDATE memory_jobs SET state='cancelled' WHERE state IN ('queued','running') AND sourceN<=?",state.forgetBeforeN)
      const result=this.get(key)
      this.store.event('memory.deleted',{key,version:result.version})
      return result
    })
  }
  source(taskId,messageId) {
    const row = messageId
      ? this.store.one("SELECT n,data FROM messages WHERE task=? AND json_extract(data,'$.messageId')=? ORDER BY n DESC LIMIT 1",taskId,messageId)
      : this.store.one("SELECT n,data FROM messages WHERE task=? AND json_extract(data,'$.role') IN ('user','assistant') ORDER BY n DESC LIMIT 1",taskId)
    requireThat(row,'memory_source_not_found',404)
    const message=JSON.parse(row.data)
    requireThat(['user','assistant'].includes(message.role) && typeof message.content === 'string','invalid_memory_source')
    return {...row,taskId,message}
  }
  indexSource(source) { return this.history.indexSource(source) }
  syncHistory(limit=256) { return this.history.sync(limit) }
  observe(taskId,messageId,binding = {}) {
    const source=this.source(taskId,messageId)
    const state=this.state()
    if (!state.enabled || source.n<=state.historyFloor) return {captured:0}
    return this.store.tx(() => {
      this.indexSource(source)
      if (source.message.role!=='user') return {captured:0}
      if (this.store.one('SELECT messageId FROM memory_observed WHERE messageId=?',source.message.messageId)) return {captured:0}
      this.store.rows('INSERT INTO memory_observed VALUES (?,?)',source.message.messageId,source.n)
      if (source.n<=state.forgetBeforeN) return {captured:0}
      let captured=0
      for (const candidate of explicitPreferences(source.message.content)) {
        const old=this.get(candidate.key)
        if (old?.status==='deleted' || old?.source.type==='user_edit') continue
        if (old?.value===candidate.value) continue
        if (!old && this.store.one("SELECT COUNT(*) AS count FROM personal_memory WHERE status='active'").count>=200) continue
        this.write({...candidate,old,source:{type:'user_statement',taskId,messageId:source.message.messageId,evidence:candidate.evidence}})
        captured++
      }
      if (state.extractionMode==='model_proposals' && mayContainPreference(source.message.content) && object(binding.profile) && Number.isSafeInteger(binding.modelEpoch)) {
        const id='memory:'+source.message.messageId
        const pending=this.store.one("SELECT COUNT(*) AS count FROM memory_jobs WHERE state IN ('queued','running')").count
        if (pending<16) this.store.rows('INSERT OR IGNORE INTO memory_jobs VALUES (?,?,\'queued\',?,0,?)',id,source.n,this.now(),JSON.stringify({
            id,taskId,messageId:source.message.messageId,profile:binding.profile,modelEpoch:binding.modelEpoch,memoryEpoch:state.epoch,
            createdAt:this.now(),usage:null
          }))
        else this.store.event('memory.extraction_skipped',{sourceMessageId:source.message.messageId,reason:'queue_capacity'})
      }
      return {captured}
    })
  }
  searchHistory(query,options={}) { return this.history.searchHistory(query,options) }
  context(taskId,{query,maxBytes=6000,mailboxId,beforeN} = {}) {
    requireThat(Number.isSafeInteger(maxBytes) && maxBytes>=256 && maxBytes<=16000,'invalid_memory_budget')
    if (!this.state().enabled) return {facts:[],preferences:[],relatedHistory:[],coverage:{enabled:false}}
    if (query===undefined) {
      const row=this.store.one("SELECT data FROM messages WHERE task=? AND json_extract(data,'$.role')='user' ORDER BY n DESC LIMIT 1",taskId)
      query=row ? JSON.parse(row.data).content : ''
    }
    const {results,coverage,capped}=this.searchHistory(query,{excludeTaskId:taskId,mailboxId,beforeN})
    const value={facts:[],preferences:[],relatedHistory:[],coverage:{...coverage,enabled:true,capped}}
    const include=(list,item,budget=maxBytes)=>{
      list.push(item)
      if (utf8.encode(JSON.stringify(value)).length>budget) {list.pop();return false}
      return true
    }
    // Give a useful historical hit room even when the user has many preferences.
    // Unused history space is released back to facts/preferences below.
    const historyReserve=results.length?Math.min(2000,Math.floor(maxBytes*0.35)):0
    const deferred=[]
    for (const row of this.store.rows("SELECT * FROM personal_memory WHERE status='active' ORDER BY (kind='fact') DESC,updatedAt DESC LIMIT 40")) {
      const {key,kind,value:text,version,source}=view(row)
      const list=kind==='fact'?value.facts:value.preferences,item={key,value:text,version,source}
      if(!include(list,item,maxBytes-historyReserve)) deferred.push([list,item])
    }
    for (const result of results) include(value.relatedHistory,result)
    for (const [list,item] of deferred) include(list,item)
    return value
  }
  proposals() { return this.list().proposals }
  decideProposal({proposalId,proposalVersion,approve}) {
    requireThat(typeof approve==='boolean','invalid_memory_decision')
    return this.store.tx(() => {
      const row=this.store.one('SELECT * FROM memory_proposals WHERE id=?',proposalId)
      requireThat(row,'memory_proposal_not_found',404)
      checkedVersion(proposalVersion,row.version)
      requireThat(row.status==='proposed','memory_proposal_closed',409)
      const proposal=JSON.parse(row.data), old=this.get(proposal.key)
      requireThat(!approve || old?.status!=='deleted','memory_deleted_requires_restore',409)
      requireThat(!approve || (old?.version || 0)===proposal.baseVersion,'memory_changed_since_proposal',409)
      let memory
      if (approve) memory=this.write({key:proposal.key,kind:'preference',value:proposal.value,old,
        source:{type:'user_approved_proposal',taskId:proposal.taskId,messageId:proposal.sourceMessageId,evidence:proposal.evidence}})
      const status=approve?'accepted':'rejected'
      this.store.rows('UPDATE memory_proposals SET status=?,version=version+1 WHERE id=?',status,proposalId)
      this.store.event('memory.proposal_decided',{proposalId,status,proposalVersion:row.version+1})
      return {proposalId,status,proposalVersion:row.version+1,...(memory?{memory}:{})}
    })
  }
  nextDue() { return this.store.one("SELECT MIN(due) AS due FROM memory_jobs WHERE state='queued'").due }
  recover() {
    this.store.tx(() => {
      for (const row of this.store.rows("SELECT * FROM memory_jobs WHERE state='running'")) {
        const data=JSON.parse(row.data)
        const state=row.attempts>=2?'failed':'queued'
        this.store.rows('UPDATE memory_jobs SET state=?,due=? WHERE id=?',state,this.now(),row.id)
        this.store.event('memory.extraction_interrupted',{jobId:row.id,taskId:data.taskId,usage:data.usage ?? null})
      }
    })
  }
  async runPending({signal} = {}) {
    const row=this.store.one("SELECT * FROM memory_jobs WHERE state='queued' AND due<=? ORDER BY due,rowid LIMIT 1",this.now())
    if (!row) return false
    const job=JSON.parse(row.data), state=this.state()
    if (!state.enabled || state.extractionMode!=='model_proposals' || state.epoch!==job.memoryEpoch || row.sourceN<=state.forgetBeforeN) {
      this.store.rows("UPDATE memory_jobs SET state='cancelled' WHERE id=?",row.id); return true
    }
    const day=Math.floor(this.now()/DAY)
    const daily=this.store.one('SELECT attempts FROM memory_daily_budget WHERE day=?',day)?.attempts || 0
    if (daily>=8) {
      this.store.rows('UPDATE memory_jobs SET due=? WHERE id=?',(day+1)*DAY,row.id)
      return false
    }
    const source=this.source(job.taskId,job.messageId)
    requireThat(source.message.role==='user','invalid_memory_source')
    const claimed=this.store.tx(()=>{
      const value=this.store.one("UPDATE memory_jobs SET state='running',attempts=attempts+1 WHERE id=? AND state='queued' RETURNING attempts",row.id)
      if (value) {
        this.store.rows('INSERT INTO memory_daily_budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1',day)
        this.store.rows('DELETE FROM memory_daily_budget WHERE day<?',day-31)
      }
      return value
    })
    if (!claimed) return false
    this.store.event('memory.extraction_started',{jobId:job.id,taskId:job.taskId,payer:'user_connection',attempt:claimed.attempts})
    try {
      requireThat(this.connections,'memory_model_not_configured')
      this.connections.assertEpoch(job.profile.connectionId,job.modelEpoch)
      const credential=this.connections.modelCredential
        ? await this.connections.modelCredential(job.profile.connectionId,job.modelEpoch)
        : {apiKey:await this.connections.credential(job.profile.connectionId,job.modelEpoch)}
      const assertActive=()=>{
        this.connections.assertEpoch(job.profile.connectionId,job.modelEpoch)
        requireThat(this.state().epoch===job.memoryEpoch &&
          this.store.one('SELECT state FROM memory_jobs WHERE id=?',job.id)?.state==='running',
          'memory_changed_during_extraction',409)
      }
      assertActive()
      let result,finish
      await withDeadline(30000,signal,async childSignal=>{
        for await (const event of this.stream({profile:{...job.profile,effort:'low'},credential,
          messages:[{role:'system',content:extractionPrompt},{role:'user',content:JSON.stringify({userMessage:source.message.content})}],
          tools:[preferenceTool],maxOutputTokens:1000,signal:childSignal})) {
          assertActive()
          if (event.type==='tool_call') {
            requireThat(!result && event.name===preferenceTool.name,'invalid_memory_extraction')
            validateTool(preferenceTool.inputSchema,event.arguments)
            result=event.arguments
          } else if (event.type==='usage') {
            job.usage={inputTokens:event.inputTokens ?? null,outputTokens:event.outputTokens ?? null,
              cacheReadTokens:event.cacheReadTokens ?? null,cacheWriteTokens:event.cacheWriteTokens ?? null,
              reasoningTokens:event.reasoningTokens ?? null,totalTokens:event.totalTokens ?? null}
            this.store.rows('UPDATE memory_jobs SET data=? WHERE id=?',JSON.stringify(job),job.id)
          } else if (event.type==='finish') finish=event
        }
      })
      requireThat(finish?.reason==='tool_calls' && result,'invalid_memory_extraction')
      assertActive()
      this.store.tx(() => {
        for (const candidate of result.preferences) {
          try { memoryKey(candidate.key);memoryValue(candidate.value) } catch { continue }
          if (!source.message.content.includes(candidate.evidence) || !safePersonalText(candidate.evidence)) continue
          const old=this.get(candidate.key)
          if (old?.status==='deleted' || old?.value===candidate.value) continue
          if (this.store.one("SELECT COUNT(*) AS count FROM memory_proposals WHERE status='proposed'").count>=64) break
          const proposal={proposalId:crypto.randomUUID(),proposalVersion:1,key:candidate.key,value:candidate.value,
            evidence:candidate.evidence,sourceMessageId:job.messageId,taskId:job.taskId,baseVersion:old?.version || 0,status:'proposed'}
          const added=this.store.one('INSERT OR IGNORE INTO memory_proposals VALUES (?,?,?,\'proposed\',1,?) RETURNING id',
            proposal.proposalId,proposal.sourceMessageId,proposal.key,JSON.stringify(proposal))
          if (added) this.store.event('memory.proposed',{proposal})
        }
        this.store.rows("UPDATE memory_jobs SET state='completed',data=? WHERE id=?",JSON.stringify(job),job.id)
        this.store.event('memory.extraction_finished',{jobId:job.id,taskId:job.taskId,status:'completed',usage:job.usage})
      })
    } catch (error) {
      const cancelled=this.state().epoch!==job.memoryEpoch || this.store.one('SELECT state FROM memory_jobs WHERE id=?',job.id)?.state==='cancelled'
      const retry=!cancelled && Boolean(error.retryable) && claimed.attempts<2
      const status=cancelled?'cancelled':retry?'queued':'failed'
      this.store.rows('UPDATE memory_jobs SET state=?,due=?,data=? WHERE id=?',status,this.now()+30000,JSON.stringify(job),job.id)
      this.store.event('memory.extraction_finished',{jobId:job.id,taskId:job.taskId,status,
        code:errorCode(error,'memory_extraction_failed'),usage:job.usage})
    }
    return true
  }
}

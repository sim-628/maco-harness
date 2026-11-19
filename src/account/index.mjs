import { identifier, requireThat, errorCode } from '../protocol.mjs'
import { exportAccount } from './export.mjs'

const openTasks = new Set(['queued','running','waiting_mail','waiting_connector','waiting_external','waiting_user','needs_review'])
const chatTables = ['messages','tasks','streams','task_context_checkpoints','task_context_attempts','work_items','interactions',
  'memory_observed','memory_excluded_sources','memory_proposals','memory_jobs','timings','operation_sessions',
  'task_schedules','schedule_daily_budget','model_usage']
const noPromise = value => requireThat(!value?.then,'async_lifecycle_fence',500)
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

/** Account-local, restartable lifecycle. This owns no alarm, no login identity,
 * and no provider-mail deletion. The host must gate every entry point and stop
 * normal maintenance while inactive; runNext drives cleanup itself. */
export class AccountLifecycleService {
  constructor(store,{assets,connections,connectors,executors,memory,sessions,participants=[],
    onFence=()=>{},activeCount=()=>0,now=Date.now,cleanupTimeoutMS=900000}={}) {
    Object.assign(this,{store,assets,connections,connectors,executors,memory,sessions,participants,onFence,activeCount,now,cleanupTimeoutMS})
    requireThat(Number.isSafeInteger(cleanupTimeoutMS) && cleanupTimeoutMS>=1000 && cleanupTimeoutMS<=3600000,'invalid_lifecycle_timeout')
    requireThat(Array.isArray(participants) && participants.length<=16 && new Set(participants.map(p=>p.name)).size===participants.length,'invalid_lifecycle_participants')
    for(const participant of participants){identifier(participant.name,'lifecycle_participant');requireThat(typeof participant.cleanup==='function','invalid_lifecycle_participant')}
    this.busy=false
    store.tx(()=>{
      store.rows('CREATE TABLE IF NOT EXISTS account_lifecycle (singleton INTEGER PRIMARY KEY,data TEXT NOT NULL)')
      store.rows('CREATE TABLE IF NOT EXISTS account_lifecycle_requests (id TEXT PRIMARY KEY,signature TEXT NOT NULL,data TEXT NOT NULL)')
      store.rows('CREATE TABLE IF NOT EXISTS account_uncertainty (kind TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id))')
      store.rows('INSERT OR IGNORE INTO account_lifecycle VALUES (1,?)',JSON.stringify({generation:1,state:'active',operation:null}))
    })
  }
  row(){return JSON.parse(this.store.one('SELECT data FROM account_lifecycle WHERE singleton=1').data)}
  generation(){return this.row().generation}
  assertActive(expectedGeneration){
    const value=this.row()
    requireThat(value.state!=='deleted','account_deleted',410)
    requireThat(value.state==='active','account_lifecycle_in_progress',409)
    requireThat(expectedGeneration===undefined || expectedGeneration===value.generation,'account_generation_changed',409)
    return value.generation
  }
  status(){
    const value=this.row(),op=value.operation
    return {generation:value.generation,state:value.state,
      operation:op?{operationId:op.id,requestId:op.requestId,mode:op.mode,resetMemories:op.resetMemories,
        state:op.state,phase:op.phase,startedAt:op.startedAt,updatedAt:op.updatedAt,completedAt:op.completedAt,
        blockedReason:op.blockedReason,retryable:op.state==='blocked',cleanup:op.cleanup || {}}:null,
      uncertainOperations:this.store.one('SELECT COUNT(*) AS n FROM account_uncertainty').n,
      retained:{identityTombstone:true,idempotencyReceipts:true,providerMailUntouched:true,supabaseIdentityUntouched:true}}
  }
  save(value){this.store.rows('UPDATE account_lifecycle SET data=? WHERE singleton=1',JSON.stringify(value));return value}
  announce(){this.store.event('account.lifecycle',{account:this.status()})}
  exists(table){return !!this.store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table)}
  clear(table){if(this.exists(table))this.store.rows('DELETE FROM '+table)}
  reset(input={}){return this.start('reset',input)}
  delete(input={}){return this.start('delete',input)}
  start(mode,{requestId=crypto.randomUUID(),expectedGeneration,resetMemories=false}={}){
    identifier(requestId,'lifecycle_request_id')
    requireThat(typeof resetMemories==='boolean','invalid_reset_memories')
    if(mode==='delete')resetMemories=true
    const signature=JSON.stringify({mode,resetMemories})
    let existing
    const value=this.store.tx(()=>{
      const prior=this.store.one('SELECT signature,data FROM account_lifecycle_requests WHERE id=?',requestId)
      if(prior){requireThat(prior.signature===signature,'lifecycle_request_conflict',409);existing=JSON.parse(prior.data);return this.row()}
      this.assertActive(expectedGeneration)
      const value=this.row(),at=this.now()
      value.generation++
      value.state=mode==='delete'?'deleting':'resetting'
      value.operation={id:crypto.randomUUID(),requestId,mode,resetMemories,state:'running',phase:'fence',
        generation:value.generation,startedAt:at,updatedAt:at,due:at,deadline:at+this.cleanupTimeoutMS,fenced:{},cleaned:{},errors:0}
      // The new epoch is committed before any abort, cancellation or network I/O.
      if(this.exists('memory_state')){
        const row=this.store.one('SELECT data FROM memory_state WHERE singleton=1')
        if(row){const memory=JSON.parse(row.data);memory.epoch++;memory.version++;this.store.rows('UPDATE memory_state SET data=? WHERE singleton=1',JSON.stringify(memory))}
      }
      this.save(value)
      this.store.rows('INSERT INTO account_lifecycle_requests VALUES (?,?,?)',requestId,signature,JSON.stringify({operationId:value.operation.id,generation:value.generation,state:'running'}))
      this.announce()
      return value
    })
    if(existing)return {request:existing,...this.status()}
    try{this.applyFence(value.operation.id)}catch(error){this.failure(value.operation.id,error)}
    return this.status()
  }
  update(id,mutate){
    return this.store.tx(()=>{
      const value=this.row();requireThat(value.operation?.id===id,'lifecycle_operation_changed',409)
      mutate(value.operation,value);value.operation.updatedAt=this.now();this.save(value);return value.operation
    })
  }
  once(id,name,fn){
    const op=this.row().operation
    if(op.fenced[name])return
    noPromise(fn())
    this.update(id,current=>{current.fenced[name]=true})
  }
  applyFence(id){
    const op=this.row().operation,reason='account_'+op.mode
    noPromise(this.onFence({operationId:id,mode:op.mode,generation:op.generation}))
    this.once(id,'local',()=>this.store.tx(()=>{
      for(const {data} of this.store.rows("SELECT data FROM tasks WHERE state IN ('queued','running','waiting_mail','waiting_connector','waiting_external','waiting_user','needs_review')")){
        const task=JSON.parse(data)
        if(openTasks.has(task.state)){task.state='cancelled';task.version++;task.error=reason;task.due=0;this.store.saveTask(task,false)}
      }
      for(const {data} of this.store.rows("SELECT data FROM operations WHERE state IN ('queued','waiting_approval')")){
        const item=JSON.parse(data);item.state='cancelled';item.version++;item.receipt={status:'cancelled',code:reason};delete item.prepared.payload
        this.store.saveOp(item)
      }
      if(this.exists('memory_jobs'))this.store.rows("UPDATE memory_jobs SET state='cancelled' WHERE state IN ('queued','running')")
      if(this.exists('task_schedules'))for(const {id,data} of this.store.rows('SELECT id,data FROM task_schedules WHERE enabled=1')){
        const schedule=JSON.parse(data);schedule.enabled=false;schedule.version++;schedule.error=reason
        this.store.rows('UPDATE task_schedules SET enabled=0,data=? WHERE id=?',JSON.stringify(schedule),id)
      }
      if(this.exists('interactions'))for(const {data} of this.store.rows("SELECT data FROM interactions WHERE state='waiting'")){
        const item=JSON.parse(data);item.state='cancelled';item.version++
        this.store.rows("UPDATE interactions SET state='cancelled',data=? WHERE id=?",JSON.stringify(item),item.interactionId)
      }
    }))
    this.once(id,'connections',()=>{
      if(this.connections?.fence)return this.connections.fence({revokeConnections:op.mode==='delete'})
      requireThat(!this.exists('connections') || !this.store.one('SELECT 1 FROM connections LIMIT 1'),'lifecycle_connections_unavailable',503)
    })
    this.once(id,'connectors',()=>{
      if(this.connectors?.fence)return this.connectors.fence({revokeConnections:op.mode==='delete'})
      requireThat(!this.exists('connector_connections') || !this.store.one('SELECT 1 FROM connector_connections LIMIT 1'),'lifecycle_connectors_unavailable',503)
    })
    this.once(id,'assets',()=>{
      if(this.assets?.erase)return this.assets.erase()
      requireThat(!this.exists('maco_assets') || !this.store.one("SELECT 1 FROM maco_assets WHERE state<>'deleted' LIMIT 1"),'lifecycle_assets_unavailable',503)
    })
    this.once(id,'executors',()=>{
      if(this.executors?.cancelAll)return this.executors.cancelAll(reason)
      requireThat(!this.exists('delegations') || !this.store.one('SELECT 1 FROM delegations WHERE due IS NOT NULL LIMIT 1'),'lifecycle_executor_unavailable',503)
    })
    if(op.mode==='delete')this.once(id,'sessions',()=>{
      if(this.sessions?.revokeAll)return this.sessions.revokeAll()
      requireThat(!this.exists('account_sessions') || !this.store.one("SELECT 1 FROM account_sessions WHERE state='active' LIMIT 1"),'lifecycle_sessions_unavailable',503)
    })
    for(const participant of this.participants)this.once(id,'participant:'+participant.name,()=>participant.fence?.({mode:op.mode,generation:op.generation}))
    this.update(id,current=>{current.phase='drain';current.due=this.now()})
  }
  localActive(){
    const primary=this.activeCount()
    requireThat(Number.isSafeInteger(primary) && primary>=0,'invalid_lifecycle_active_count',500)
    const assets=this.assets?.cleanupStatus?.()
    return primary+count(this.connectors?.activeCount?.())+count(this.executors?.cleanupStatus?.().active)+
      count(assets?.activeUploads)+count(assets?.activeParses)+this.participants.reduce((sum,p)=>sum+count(p.activeCount?.()),0)
  }
  uncertain(kind,item,generation){
    const value={kind,operationId:item.id,state:'unknown',generation,code:item.receipt?.code || 'outcome_unconfirmed',recordedAt:this.now()}
    this.store.rows('INSERT INTO account_uncertainty VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation,data=excluded.data',kind,item.id,generation,JSON.stringify(value))
  }
  eraseLocal(id){
    requireThat(this.localActive()===0,'lifecycle_local_work_active',409)
    const op=this.row().operation
    this.store.tx(()=>{
      for(const {data} of this.store.rows("SELECT data FROM operations WHERE state IN ('dispatching','unknown')")){
        const item=JSON.parse(data);item.state='unknown';item.receipt={status:'unknown',code:item.receipt?.code || 'account_changed_after_dispatch'}
        item.version++;item.taskId=null;delete item.assetIds;delete item.mailboxIds
        item.prepared={action:item.prepared.action,resource:item.prepared.resource,summary:{redacted:true},requiresApproval:true}
        this.uncertain('mail',item,op.generation)
        this.store.rows("UPDATE operations SET state='unknown',task=NULL,data=? WHERE id=?",JSON.stringify(item),item.id)
      }
      this.store.rows("DELETE FROM operations WHERE state<>'unknown'")
      if(this.exists('connector_operations')){
        for(const {data} of this.store.rows("SELECT data FROM connector_operations WHERE state IN ('dispatching','unknown')")){
          const item=JSON.parse(data);item.state='unknown';item.arguments={};item.taskId=null;item.runId=null;item.version++
          item.receipt={status:'unknown',code:item.receipt?.code || 'account_changed_after_dispatch'}
          this.uncertain('connector',item,op.generation)
          this.store.rows("UPDATE connector_operations SET state='unknown',task=NULL,data=? WHERE id=?",JSON.stringify(item),item.id)
        }
        this.store.rows("DELETE FROM connector_operations WHERE state<>'unknown'")
      }
      if(this.exists('memory_history_fts'))this.store.rows("INSERT INTO memory_history_fts(memory_history_fts) VALUES ('delete-all')")
      this.clear('memory_history')
      for(const table of chatTables)this.clear(table)
      if(this.exists('memory_state')){
        const row=this.store.one('SELECT data FROM memory_state WHERE singleton=1')
        if(row){const memory=JSON.parse(row.data);memory.historyCursor=0;memory.historyFloor=0;memory.forgetBeforeN=0;this.store.rows('UPDATE memory_state SET data=? WHERE singleton=1',JSON.stringify(memory))}
      }
      if(op.resetMemories)this.clear('personal_memory')
      else if(this.exists('personal_memory'))for(const row of this.store.rows('SELECT key,source FROM personal_memory')){
        const source=JSON.parse(row.source)
        this.store.rows('UPDATE personal_memory SET source=? WHERE key=?',JSON.stringify({type:source.type || 'user_edit',retainedAfterReset:true}),row.key)
      }
      // An old successful command ID must not be replayed as a fresh mail send
      // after chat reset. Keep only its digest and a content-free retired receipt.
      this.store.rows('UPDATE commands SET result=?',JSON.stringify({retired:true,code:'command_retired',generation:op.generation}))
      this.clear('events')
      if(op.mode==='delete'){
        for(const table of ['mail_index_fts','mail_index','mail_index_changes','mail_sync','mail_index_meta','device_analysis','revisions','mail_observations',
          'model_endpoints','mail_oauth','connections','memory_daily_budget'])this.clear(table)
        this.clear('operations')
      }
      this.executors?.redactAll?.()
      if(op.mode==='delete')this.connectors?.erase?.()
      this.update(id,current=>{current.phase='cleanup_remote';current.localErasedAt=this.now();current.due=this.now()})
    })
  }
  progress(id,phase,due=this.now()) {this.update(id,op=>{op.phase=phase;op.due=due})}
  block(id,reason){
    this.update(id,(op,value)=>{op.state='blocked';op.blockedReason=reason;op.due=null;value.state='blocked'})
    this.announce()
  }
  failure(id,error){
    const op=this.update(id,current=>{current.errors++;current.lastError=errorCode(error,'lifecycle_cleanup_failed');current.due=this.now()+Math.min(60000,1000*2**Math.min(current.errors,6))})
    if(op.errors>=6 || this.now()>=op.deadline)this.block(id,op.lastError)
  }
  nextDue(){const value=this.row();return value.operation?.state==='running'?value.operation.due:null}
  recover(){
    const value=this.row()
    if(value.state==='active'||value.state==='deleted')return
    noPromise(this.onFence({operationId:value.operation.id,mode:value.operation.mode,generation:value.generation}))
    this.executors?.recover?.();this.assets?.recover?.()
    if(value.operation.state==='running')this.update(value.operation.id,op=>{op.due=this.now()})
  }
  retry({operationId}={}){
    const value=this.row();identifier(operationId,'lifecycle_operation_id')
    requireThat(value.operation?.id===operationId && value.operation.state==='blocked','lifecycle_not_blocked',409)
    this.update(operationId,(op,current)=>{
      op.state='running';delete op.blockedReason;op.errors=0;op.deadline=this.now()+this.cleanupTimeoutMS;op.due=this.now()
      for(const status of Object.values(op.cleanup?.participants || {})){delete status.unknown;status.nextDue=0}
      if(['cleanup_remote','cleanup_assets','cleanup_participants','finalize'].includes(op.phase))op.phase='cleanup_remote'
      current.state=op.mode==='delete'?'deleting':'resetting'
    })
    this.executors?.retryCleanup?.()
    return this.status()
  }
  async runNext(signal){
    if(this.busy)return false
    const value=this.row(),op=value.operation
    if(!op || op.state!=='running' || op.due>this.now())return false
    this.busy=true
    try{
      signal?.throwIfAborted()
      if(this.now()>=op.deadline){this.block(op.id,op.phase==='drain'?'local_drain_unconfirmed':'cleanup_unconfirmed');return true}
      switch(op.phase){
        case 'fence':this.applyFence(op.id);break
        case 'drain':
          this.progress(op.id,this.localActive()?'drain':'erase_local',this.now()+100);break
        case 'erase_local':this.eraseLocal(op.id);break
        case 'cleanup_remote':{
          if(this.executors && this.executors.nextDue()!==null && this.executors.nextDue()<=this.now())await this.executors.runNext(signal)
          const status=this.executors?.cleanupStatus?.() || {complete:true,pending:0,unknown:0}
          this.update(op.id,current=>{current.cleanup={...current.cleanup,hosted:status}})
          this.progress(op.id,'cleanup_assets')
          break
        }
        case 'cleanup_assets':{
          if(this.assets)await this.assets.cleanup({limit:8,signal})
          const status=this.assets?.cleanupStatus?.() || {complete:true,pending:0}
          this.update(op.id,current=>{current.cleanup={...current.cleanup,assets:status}})
          this.progress(op.id,'cleanup_participants')
          break
        }
        case 'cleanup_participants':{
          const pending=this.participants.find(item=>!op.cleaned[item.name] && !op.cleanup?.participants?.[item.name]?.unknown &&
            (op.cleanup?.participants?.[item.name]?.nextDue || 0)<=this.now())
          if(pending){
            const result=await pending.cleanup({mode:op.mode,generation:op.generation,signal})
            requireThat(result && typeof result.complete==='boolean','invalid_lifecycle_cleanup_result',500)
            this.update(op.id,current=>{
              current.cleanup ||= {};current.cleanup.participants ||= {}
              current.cleanup.participants[pending.name]={complete:result.complete,unknown:result.unknown===true,
                nextDue:Math.max(this.now()+1000,Number.isSafeInteger(result.nextDue)?result.nextDue:this.now()+5000)}
              if(result.complete)current.cleaned[pending.name]=true
              current.due=this.now()
            })
          }else this.continueCleanup(op.id)
          break
        }
        case 'finalize':this.finalize(op.id);break
        default:requireThat(false,'invalid_lifecycle_phase',500)
      }
    }catch(error){if(signal?.aborted)this.progress(op.id,this.row().operation.phase,this.now()+1000);else this.failure(op.id,error)}
    finally{this.busy=false}
    return true
  }
  continueCleanup(id){
    const op=this.row().operation,hosted=op.cleanup?.hosted || {complete:true},assets=op.cleanup?.assets || {complete:true}
    const pending=this.participants.filter(item=>!op.cleaned[item.name])
    const unknownParticipant=pending.find(item=>op.cleanup?.participants?.[item.name]?.unknown)
    const otherPending=!assets.complete || !hosted.complete && !hosted.unknown || pending.some(item=>!op.cleanup?.participants?.[item.name]?.unknown)
    if((hosted.unknown || unknownParticipant) && !otherPending){
      this.block(id,hosted.unknown?'hosted_outcome_unknown':unknownParticipant.name+'_cleanup_unknown');return
    }
    if(hosted.complete && assets.complete && !pending.length){this.progress(id,'finalize');return}
    const dates=[!hosted.complete?this.executors?.nextDue():null,!assets.complete?this.assets?.nextDue():null,
      ...pending.filter(item=>!op.cleanup?.participants?.[item.name]?.unknown).map(item=>op.cleanup?.participants?.[item.name]?.nextDue || this.now()+1000)]
      .filter(value=>Number.isSafeInteger(value))
    this.progress(id,'cleanup_remote',Math.max(this.now()+100,dates.length?Math.min(...dates):this.now()+5000))
  }
  finalize(id){
    requireThat(this.localActive()===0,'lifecycle_local_work_active',409)
    requireThat(!this.executors || this.executors.cleanupStatus().complete,'execution_cleanup_pending',409)
    requireThat(!this.assets || this.assets.cleanupStatus().complete,'asset_cleanup_pending',409)
    this.store.tx(()=>{
      this.executors?.erase?.();this.assets?.purgeRetired?.()
      // Provider cancellation/cleanup can publish late token counts through the
      // shared event observer. Erase those final account-local usage records too.
      this.clear('model_usage')
      this.clear('events')
      const value=this.row(),op=value.operation
      requireThat(op.id===id,'lifecycle_operation_changed',409)
      op.phase='completed';op.state='completed';op.due=null;op.completedAt=this.now();op.updatedAt=this.now()
      value.state=op.mode==='delete'?'deleted':'active'
      if(op.mode==='delete')value.deletedAt=this.now()
      this.save(value)
      this.store.rows('UPDATE account_lifecycle_requests SET data=? WHERE id=?',JSON.stringify({operationId:id,generation:value.generation,state:'completed',completedAt:op.completedAt}),op.requestId)
      this.announce()
    })
  }
  export(options){return exportAccount(this.store,{generation:()=>this.generation(),assertActive:g=>this.assertActive(g),now:this.now},options)}
}

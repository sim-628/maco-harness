import { identifier, messageText, checkedVersion, requireThat, errorCode } from './protocol.mjs'

const DAY=86400000
const view = record => {const {binding,authorizationSession,...value}=record;return {...value,modelProfile:binding.profile,
  mailboxIds:binding.mailboxIds,connectorIds:binding.connectorIds}}

// Explicit opt-in, read-only proactive tasks. A schedule creates ordinary
// independent tasks and shares their budgets, provider adapter and event log.
export class ScheduleService {
  constructor(store,{harness,assertCurrent=()=>{},now=Date.now}) {
    Object.assign(this,{store,harness,assertCurrent,now})
    store.rows('CREATE TABLE IF NOT EXISTS schedule_daily_budget (day INTEGER PRIMARY KEY,runs INTEGER NOT NULL)')
    store.rows('CREATE TABLE IF NOT EXISTS task_schedules (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,due INTEGER NOT NULL,data TEXT NOT NULL)')
    store.rows('CREATE INDEX IF NOT EXISTS task_schedule_due ON task_schedules(enabled,due)')
  }
  save(value) {
    this.store.rows('INSERT INTO task_schedules VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,due=excluded.due,data=excluded.data',value.id,Number(value.enabled),value.nextAt,JSON.stringify(value))
    this.store.event('schedule.updated',{schedule:view(value)})
    return {schedule:view(value)}
  }
  upsert({id=crypto.randomUUID(),expectedVersion=0,name,message,modelProfile,mailboxIds=[],connectorIds=[],
    intervalMinutes=1440,nextAt,enabled=true,maxRunsPerDay=4,timeZone='UTC',conversationId='primary'},authorizationSession) {
    identifier(id,'schedule_id');identifier(conversationId,'conversation_id')
    requireThat(typeof name==='string' && name.trim() && name.length<=200,'invalid_schedule_name')
    messageText(message)
    requireThat(Number.isInteger(intervalMinutes) && intervalMinutes>=60 && intervalMinutes<=30*1440,'invalid_schedule_interval')
    requireThat(Number.isInteger(maxRunsPerDay) && maxRunsPerDay>=1 && maxRunsPerDay<=24,'invalid_schedule_budget')
    requireThat(typeof enabled==='boolean' && typeof timeZone==='string' && timeZone.length<80,'invalid_schedule')
    try {new Intl.DateTimeFormat('en',{timeZone})} catch {requireThat(false,'invalid_time_zone')}
    const due=nextAt ?? this.now()+intervalMinutes*60000
    requireThat(Number.isSafeInteger(due) && due>=0,'invalid_schedule')
    const old=this.store.one('SELECT data FROM task_schedules WHERE id=?',id)
    const previous=old && JSON.parse(old.data)
    checkedVersion(expectedVersion,previous?.version || 0)
    requireThat(previous || this.store.one('SELECT COUNT(*) AS n FROM task_schedules').n<32,'schedule_capacity_reached',429)
    const binding=this.harness.bind(modelProfile,{mailboxIds,connectorIds,allowHosted:false,readOnly:true})
    return this.save({id,name,message,binding,enabled,intervalMinutes,maxRunsPerDay,timeZone,conversationId,nextAt:due,
      authorizationSession,version:(previous?.version || 0)+1,day:previous?.day ?? 0,runsToday:previous?.runsToday || 0,
      lastTaskId:previous?.lastTaskId || null,lastRunAt:previous?.lastRunAt || null,error:null})
  }
  cancel({id,expectedVersion}) {
    const row=this.store.one('SELECT data FROM task_schedules WHERE id=?',identifier(id,'schedule_id'))
    requireThat(row,'schedule_not_found',404)
    const value=JSON.parse(row.data)
    checkedVersion(expectedVersion,value.version)
    value.version++;value.enabled=false
    return this.save(value)
  }
  list() {return {schedules:this.store.rows('SELECT data FROM task_schedules ORDER BY due LIMIT 32').map(row=>view(JSON.parse(row.data)))}}
  nextDue() {return this.store.one('SELECT MIN(due) AS due FROM task_schedules WHERE enabled=1').due}
  runNext() {
    const row=this.store.one('SELECT data FROM task_schedules WHERE enabled=1 AND due<=? ORDER BY due LIMIT 1',this.now())
    if (!row) return
    let value=JSON.parse(row.data)
    try { this.store.tx(()=>{
      const day=Math.floor(this.now()/DAY)
      if (value.day!==day) {value.day=day;value.runsToday=0}
        this.assertCurrent(value)
        if (value.runsToday>=value.maxRunsPerDay || (this.store.one('SELECT runs FROM schedule_daily_budget WHERE day=?',day)?.runs || 0)>=24) {value.nextAt=(day+1)*DAY;this.save(value);return}
        const task=this.harness.create({message:value.message,modelProfile:value.binding.profile,mailboxIds:value.binding.mailboxIds,
          connectorIds:value.binding.connectorIds,readOnly:true,allowHosted:false,priority:'background',timeZone:value.timeZone,
          conversationId:value.conversationId,authorizationSession:value.authorizationSession})
        this.store.rows('INSERT INTO schedule_daily_budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET runs=runs+1',day)
        this.store.rows('DELETE FROM schedule_daily_budget WHERE day<?',day-31)
        value.lastTaskId=task.taskId;value.lastRunAt=this.now();value.runsToday++;value.error=null
        // Advance in the same transaction as task creation; a missed interval
        // never causes a catch-up burst or a second run after restart.
        value.nextAt=this.now()+value.intervalMinutes*60000
      this.save(value)
    }) } catch(error) {
      // Let the task, messages, events and daily budget roll back together.
      // Record the failed schedule only after the failed transaction is gone.
      value=JSON.parse(row.data)
      value.error=errorCode(error,'schedule_failed')
      if (value.error==='task_capacity_reached') value.nextAt=this.now()+60000
      else value.enabled=false
      this.store.tx(()=>this.save(value))
    }
  }
}

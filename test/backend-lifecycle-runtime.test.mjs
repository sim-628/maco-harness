import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick,setTimeout as sleep } from 'node:timers/promises'
import { AgentService } from '../src/service.mjs'
import { scopedMailTools } from '../src/task-scope.mjs'
import { ModelError } from '../src/model/stream.mjs'
import { createStorage } from './support/storage.mjs'

const cmd=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const error=code=>Object.assign(Error(code),{code})

class Bucket {
  objects=new Map()
  hook=null
  async put(key,bytes,options) {
    const object={key,size:bytes.length,bytes:bytes.slice(),customMetadata:options.customMetadata,httpMetadata:options.httpMetadata}
    this.objects.set(key,object)
    if(this.hook)await this.hook()
    return this.head(key)
  }
  async head(key) {const object=this.objects.get(key);if(!object)return null;const {bytes,...meta}=object;return structuredClone(meta)}
  async get(key) {const object=this.objects.get(key);return object ? {...await this.head(key),body:new Blob([object.bytes]).stream()} : null}
  async delete(key) {this.objects.delete(key)}
}

async function fixture(t,{stream=async function*(){yield {type:'finish',reason:'stop'}},automatic=false,bucket}={}) {
  const storage=createStorage(),pending=new Set(),failures=[]
  const ctx={storage,id:{toString:()=> 'runtime-test-owner'},waitUntil(promise){
    pending.add(promise)
    promise.then(()=>pending.delete(promise),failure=>{failures.push(failure);pending.delete(promise)})
  }}
  const env={CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,14).toString('base64'),...(bucket ? {ASSETS:bucket} : {})}
  const options={model:{stream},fetcher:()=>{throw Error('external request forbidden in integration fixture')}}
  let service=new AgentService(ctx,env,options)
  if(!automatic)service.host.kick=()=>{}
  const connection=await service.connections.putModel({provider:'openai',apiKey:'fixture-only-key'})
  const profile={provider:'openai',model:'original-model',connectionId:connection.id}
  const now=Math.floor(Date.now()/1000)
  const authorization=service.sessions.accept({sessionId:'fixture-device',issuedAt:now,expires:now+3600})
  t.after(()=>storage.close())
  async function drain() {
    for(let n=0;n<100;n++) {
      await tick()
      if(!pending.size)return
      await Promise.allSettled([...pending])
    }
    assert.fail('runtime did not settle')
  }
  return {get service(){return service},storage,ctx,env,profile,authorization,pending,failures,drain,
    command:(type,fields={})=>service.command(cmd(type,fields),authorization),
    reopen(){assert.equal(pending.size,0);service=new AgentService(ctx,env,options);if(!automatic)service.host.kick=()=>{};return service},
    mailbox(){
      service.store.rows("INSERT INTO connections VALUES (?,'mail','gmail',?,'active',1,?,?,?,NULL)",'mailbox','google-fixture',
        JSON.stringify(['mark_read','send']),JSON.stringify(['https://www.googleapis.com/auth/gmail.modify']),'fixture-generation')
      return 'mailbox'
    }}
}

async function until(read,ready,timeout=4000) {
  const end=Date.now()+timeout
  let value
  do {value=await read();if(ready(value))return value;await sleep(5)} while(Date.now()<end)
  assert.fail('runtime transition timed out: '+JSON.stringify(value))
}

test('AgentService reset fences the scheduler and waits for a late model before erasing its task',{timeout:10000},async t=>{
  const entered=deferred(),release=deferred()
  let calls=0,wasAborted=false
  const f=await fixture(t,{automatic:true,async *stream({signal}){
    calls++
    if(calls===1) {
      entered.resolve()
      await release.promise
      wasAborted=signal.aborted
      yield {type:'text_delta',text:'late private output'}
    } else yield {type:'text_delta',text:'new generation output'}
    yield {type:'finish',reason:'stop'}
  }})
  try {
    const create=cmd('task.create',{message:'private first-generation input',modelProfile:f.profile})
    const task=await f.service.command(create,f.authorization)
    await entered.promise
    const reset=f.service.lifecycle.reset({requestId:'runtime-reset',expectedGeneration:1})
    assert.equal(reset.generation,2)
    f.service.host.kick()
    await until(()=>f.service.lifecycle.status(),value=>value.operation.phase==='drain')
    assert.equal(f.service.store.getTask(task.taskId).state,'cancelled')
    assert.equal(f.service.host.tasks.size,1)
    await assert.rejects(f.command('task.create',{message:'must not run while resetting',modelProfile:f.profile}),{code:'account_lifecycle_in_progress'})
    release.resolve()
    await until(()=>{f.service.host.kick();return f.service.lifecycle.status()},value=>value.state==='active')
    await f.drain()
    assert.equal(wasAborted,true)
    assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,0)
    assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM messages').n,0)
    assert.equal(f.service.usage.page().usage.length,0)
    assert.equal((await f.service.command(create,f.authorization)).retired,true)
    const next=await f.command('task.create',{message:'new generation input',modelProfile:f.profile})
    await f.drain()
    assert.equal(f.service.store.getTask(next.taskId).state,'completed')
    assert.equal(f.service.store.messages(next.taskId).at(-1).content,'new generation output')
    assert.deepEqual(f.failures,[])
  } finally {release.resolve();await f.drain()}
})

test('AgentService delete waits for an in-flight R2 write and never starts due schedule work',{timeout:10000},async t=>{
  const bucket=new Bucket(),entered=deferred(),release=deferred()
  bucket.hook=async()=>{entered.resolve();await release.promise}
  let models=0
  const f=await fixture(t,{bucket,automatic:true,async *stream(){models++;yield {type:'finish',reason:'stop'}}})
  try {
    const upload=f.service.assets.put({name:'private.txt',mimeType:'text/plain',body:'private original'})
    const cancelled=assert.rejects(upload,{code:'asset_changed'})
    await entered.promise
    f.service.schedules.upsert({id:'due-now',name:'Future review',message:'Never execute during deletion',modelProfile:f.profile,nextAt:0},f.authorization.sessionId)
    f.service.lifecycle.delete({requestId:'runtime-delete'})
    f.service.host.kick()
    await until(()=>f.service.lifecycle.status(),value=>value.operation.phase==='drain')
    assert.equal(f.service.assets.cleanupStatus().activeUploads,1)
    assert.equal(models,0)
    release.resolve()
    await cancelled
    await until(()=>{f.service.host.kick();return f.service.lifecycle.status()},value=>value.state==='deleted')
    await f.drain()
    assert.equal(bucket.objects.size,0)
    assert.equal(f.service.connections.list().length,0)
    assert.equal(f.service.schedules.list().schedules.length,0)
    assert.equal(models,0)
    assert.throws(()=>f.service.assertAvailable(),{code:'account_deleted'})
    assert.deepEqual(f.failures,[])
  } finally {release.resolve();await f.drain()}
})

test('schedules create one read-only background task across reconstruction and cannot enable hosted writes',async t=>{
  const f=await fixture(t)
  const mailboxId=f.mailbox(),at=Date.now()
  f.service.schedules.now=()=>at
  const input={id:'review',name:'Inbox review',message:'Summarize incoming mail',modelProfile:f.profile,
    mailboxIds:[mailboxId],nextAt:at,intervalMinutes:60,maxRunsPerDay:1,readOnly:false,allowHosted:true}
  const accepted=await f.command('schedule.upsert',input)
  assert.equal(accepted.schedule.version,1)
  f.service.schedules.runNext()
  const schedule=f.service.schedules.list().schedules[0]
  const task=f.service.store.getTask(schedule.lastTaskId)
  assert.equal(task.priority,'background')
  assert.equal(task.readOnly,true)
  assert.equal(task.allowHosted,false)
  assert.equal(task.authorizationSession,f.authorization.sessionId)
  assert.ok(!scopedMailTools(task,f.service.mail).some(tool=>tool.name==='mail_write'))
  assert.ok(!(await f.service.runtime.tools(task)).some(tool=>tool.name==='delegate_task'))
  assert.equal(schedule.runsToday,1)
  assert.equal(schedule.nextAt,at+3600000)
  f.reopen();f.service.schedules.now=()=>at
  f.service.schedules.runNext()
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,1)
  f.service.schedules.now=()=>at+3600000
  f.service.schedules.runNext()
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,1)
  assert.equal(f.service.schedules.list().schedules[0].nextAt,(Math.floor(at/86400000)+1)*86400000)
})

test('proactive account-wide daily admission never creates more than 24 tasks',async t=>{
  const f=await fixture(t),at=Date.now()
  f.service.schedules.now=()=>at
  for(let i=0;i<25;i++)f.service.schedules.upsert({id:'schedule-'+i,name:'Review '+i,message:'Read-only review '+i,
    modelProfile:f.profile,nextAt:0,intervalMinutes:60,maxRunsPerDay:24},f.authorization.sessionId)
  for(let i=0;i<25;i++)f.service.schedules.runNext()
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,24)
  assert.equal(f.service.store.one('SELECT runs FROM schedule_daily_budget WHERE day=?',Math.floor(at/86400000)).runs,24)
  assert.equal(f.service.schedules.list().schedules.filter(item=>item.lastTaskId===null).length,1)
})

test('a scheduled model cannot force a hidden mail-write tool into the execution ledger',async t=>{
  const f=await fixture(t,{async *stream({tools}){
    assert.ok(!tools.some(tool=>tool.name==='mail_write'))
    yield {type:'tool_call',id:'unoffered-write',name:'mail_write',arguments:{action:'send',mailboxId:'mailbox',
      to:['recipient@example.com'],subject:'Forbidden schedule write',body:'must not be dispatched'}}
    yield {type:'finish',reason:'tool_calls'}
  }})
  f.service.schedules.upsert({id:'readonly',name:'Review',message:'Read mail',modelProfile:f.profile,
    mailboxIds:[f.mailbox()],nextAt:0},f.authorization.sessionId)
  f.service.schedules.runNext()
  const task=f.service.store.getTask(f.service.schedules.list().schedules[0].lastTaskId)
  task.state='running';f.service.store.saveTask(task)
  await f.service.harness.run(task,new AbortController().signal)
  const result=f.service.store.getTask(task.id)
  assert.equal(result.state,'failed')
  assert.equal(result.error,'tool_not_allowed_or_budget_exhausted')
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM operations').n,0)
})

test('schedule credential rotation and revoked authorization disable future work without model calls',async t=>{
  const f=await fixture(t)
  for(const id of ['changed-key','revoked-session'])f.service.schedules.upsert({id,name:id,message:'Scheduled review',
    modelProfile:f.profile,nextAt:0},f.authorization.sessionId)
  await f.service.connections.putModel({id:f.profile.connectionId,expectedEpoch:1,provider:'openai',apiKey:'rotated-key'})
  f.service.schedules.runNext()
  let changed=f.service.schedules.list().schedules.find(item=>item.id==='changed-key')
  assert.equal(changed.enabled,false)
  assert.equal(changed.error,'connection_changed')
  const current=f.service.schedules.list().schedules.find(item=>item.id==='revoked-session')
  f.service.schedules.upsert({...current,expectedVersion:current.version,modelProfile:f.profile,nextAt:0},f.authorization.sessionId)
  f.service.sessions.revoke({sessionId:f.authorization.sessionId,expectedVersion:1})
  f.service.schedules.runNext()
  const revoked=f.service.schedules.list().schedules.find(item=>item.id==='revoked-session')
  assert.equal(revoked.enabled,false)
  assert.equal(revoked.error,'session_revoked')
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,0)
  assert.equal(f.service.schedules.nextDue(),null)
})

test('a failed scheduled task initialization rolls back its task, messages and day-budget as one unit',async t=>{
  const f=await fixture(t)
  f.service.schedules.upsert({id:'failed-create',name:'Review',message:'Review',modelProfile:f.profile,nextAt:0},f.authorization.sessionId)
  f.service.memory.observe=()=>{throw error('fixture_memory_failure')}
  f.service.schedules.runNext()
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM tasks').n,0)
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM messages').n,0)
  assert.equal(f.service.store.one('SELECT COUNT(*) AS n FROM schedule_daily_budget').n,0)
  assert.equal(f.service.schedules.list().schedules[0].enabled,false)
})

test('usage preserves a task attempt model through a later model swap and keeps absent token fields unknown',async t=>{
  const f=await fixture(t)
  const task=await f.command('task.create',{message:'First model',modelProfile:f.profile})
  f.service.store.event('attempt.started',{taskId:task.taskId,runId:task.runId,messageId:'original-attempt'})
  const steered=await f.command('task.steer',{taskId:task.taskId,taskVersion:task.taskVersion,message:'Change model',modelProfile:{...f.profile,model:'changed-model'}})
  f.service.store.event('attempt.abandoned',{taskId:task.taskId,runId:task.runId,messageId:'original-attempt',usage:{inputTokens:17,cacheReadTokens:4}})
  f.service.store.event('attempt.started',{taskId:task.taskId,runId:steered.runId,messageId:'unknown-attempt'})
  f.service.store.event('attempt.abandoned',{taskId:task.taskId,runId:steered.runId,messageId:'unknown-attempt'})
  const usage=f.service.usage.page().usage
  const original=usage.find(item=>item.id==='original-attempt')
  assert.equal(original.model,'original-model')
  assert.equal(original.provider,'openai')
  assert.equal(original.usage.inputTokens,17)
  assert.equal(original.usage.outputTokens,null)
  assert.equal(original.usage.totalTokens,null)
  const unknown=usage.find(item=>item.id==='unknown-attempt')
  assert.equal(unknown.model,'changed-model')
  assert.equal(unknown.usage,null)
  assert.equal(unknown.costUSD,null)
  assert.equal(unknown.billingComplete,false)
})

test('preference extraction usage identifies the frozen source model after the parent task changes model',async t=>{
  const actual=[]
  const f=await fixture(t,{async *stream({profile}){
    actual.push(profile.model)
    yield {type:'usage',inputTokens:13,outputTokens:2}
    yield {type:'tool_call',name:'propose_preferences',arguments:{preferences:[]}}
    yield {type:'finish',reason:'tool_calls'}
  }})
  f.service.memory.configure({extractionMode:'model_proposals',expectedVersion:f.service.memory.state().version})
  const task=await f.command('task.create',{message:'我习惯在午饭以后集中处理邮件。',modelProfile:f.profile})
  await f.command('task.steer',{taskId:task.taskId,taskVersion:task.taskVersion,message:'Continue later',modelProfile:{...f.profile,model:'changed-model'}})
  await f.service.memory.runPending()
  assert.deepEqual(actual,['original-model'])
  const extraction=f.service.usage.page().usage.find(item=>item.kind==='preference_extraction')
  assert.equal(extraction.model,'original-model')
  assert.equal(extraction.usage.inputTokens,13)
})

test('preference extraction retries retain separate attempts and do not copy old tokens into an unknown retry',async t=>{
  let attempt=0,time=Date.now()
  const f=await fixture(t,{async *stream(){
    attempt++
    if(attempt===1){yield {type:'usage',inputTokens:11};throw new ModelError('model_transport_error',{retryable:true})}
    yield {type:'tool_call',name:'propose_preferences',arguments:{preferences:[]}}
    yield {type:'finish',reason:'tool_calls'}
  }})
  f.service.memory.now=()=>time
  f.service.memory.configure({extractionMode:'model_proposals',expectedVersion:f.service.memory.state().version})
  await f.command('task.create',{message:'我习惯在午饭以后集中处理邮件。',modelProfile:f.profile})
  await f.service.memory.runPending()
  time+=30001
  await f.service.memory.runPending()
  assert.equal(attempt,2)
  const rows=f.service.usage.page().usage.filter(item=>item.kind==='preference_extraction')
  assert.equal(rows.length,2)
  assert.equal(rows.filter(item=>item.usage?.inputTokens===11).length,1)
  assert.equal(rows.filter(item=>item.usage===null).length,1)
  assert.ok(rows.every(item=>item.costUSD===null && item.billingComplete===false))
})

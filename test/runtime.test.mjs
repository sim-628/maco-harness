import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { prepareMailCommand } from '../src/mail/index.mjs'
import { AgentService } from '../src/service.mjs'
import { createStorage } from './support/storage.mjs'

const profile = {provider:'openai',model:'gpt-test',connectionId:'model'}
const actions = ['archive','trash','send','mark_read']
const metadata = {box:{id:'box',kind:'mail',provider:'gmail',scopes:['https://www.googleapis.com/auth/gmail.modify'],actions,epoch:1,status:'active'},
  model:{id:'model',kind:'model',provider:'openai',epoch:1,status:'active'}}
const cmd = (type,fields) => ({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})
const create = message => cmd('task.create',{modelProfile:profile,mailboxId:'box',message})
const submit = input => cmd('mail.submit',{mailboxId:'box',items:[{input}]})
const send = {action:'send',to:['person@example.org'],body:'Reviewed copy',subject:'Notes'}

function fixture(options = {}) {
  const storage = options.storage || createStorage()
  const jobs = new Set()
  const ctx = {storage,waitUntil(p) { jobs.add(p); p.then(() => jobs.delete(p),() => jobs.delete(p)) }}
  const records = structuredClone(metadata)
  const connections = {get:id=>records[id],assertEpoch(id,epoch) {
    if (records[id].epoch !== epoch || records[id].status !== 'active') throw Object.assign(new Error(),{code:'connection_changed',status:409})
  },async credential(id,epoch) { this.assertEpoch(id,epoch); return 'fixture-only' }}
  const writes = []
  const mail = {prepare:(input,ctx) => prepareMailCommand(input,{...ctx, fetchImpl:async url => {
    assert.equal(String(url),'https://gmail.googleapis.com/gmail/v1/users/me/profile')
    return Response.json({emailAddress:'sender@example.org'})
  }}),execute:async (prepared,context) => {
    context.beforeWrite()
    writes.push(prepared)
    return {status:'succeeded',providerId:'id-'+writes.length}
  }, ...options.mail}
  const service = new AgentService(ctx,{}, {connections,mail,model:options.model})
  return {service,storage,writes,records, async drain() {
    for (let i=0;i<100;i++) {
      await tick()
      if (!jobs.size) return
      await Promise.all([...jobs])
    }
    assert.fail('scheduler did not settle')
  }}
}

test('per-user admission limits reject new work without losing idempotent retries or blocking cancellation',async () => {
  const f=fixture()
  f.service.host.kick=()=>{}
  f.service.harness.maxOpenTasks=2
  f.service.mail.maxPending=2
  const request=create('first')
  const a=await f.service.command(request)
  await f.service.command(create('second'))
  await assert.rejects(f.service.command(create('overflow')),{code:'task_capacity_reached',status:429})
  assert.deepEqual(await f.service.command(request),a)
  await f.service.command(cmd('task.cancel',{taskId:a.taskId,taskVersion:a.taskVersion}))
  await f.service.command(create('capacity released'))
  const first=await f.service.command(submit({action:'mark_read',messageId:'one'}))
  await f.service.command(submit({action:'mark_read',messageId:'two'}))
  await assert.rejects(f.service.command(submit({action:'mark_read',messageId:'three'})),{code:'operation_capacity_reached',status:429})
  await f.service.command(cmd('mail.cancel',{operationId:first.operations[0].operationId,approvalVersion:1}))
  await f.service.command(submit({action:'mark_read',messageId:'three'}))
  assert.equal(f.writes.length,0)
})

test('durable preference extraction resumes after foreground completion and never changes its model tools',async () => {
  const text='我习惯在午饭以后集中处理邮件。'
  const order=[]
  const model={async *stream({tools,messages}) {
    if (tools.some(tool=>tool.name==='propose_preferences')) {
      order.push('extraction')
      assert.equal(messages.length,2)
      assert.deepEqual(JSON.parse(messages[1].content),{userMessage:text})
      yield {type:'tool_call',name:'propose_preferences',arguments:{preferences:[{key:'mail.review_time',value:'after lunch',evidence:text}]}}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      order.push('foreground')
      assert.ok(tools.some(tool=>tool.name==='mail_search'))
      yield {type:'text_delta',text:'Understood.'}
      yield {type:'finish',reason:'stop'}
    }
  }}
  const initial=fixture({model})
  initial.service.host.kick=()=>{}
  await initial.service.command(cmd('memory.configure',{extractionMode:'model_proposals',expectedVersion:1}))
  const task=await initial.service.command(create(text))
  assert.notEqual(initial.service.memory.nextDue(),null)
  const restarted=fixture({storage:initial.storage,model})
  await restarted.service.host.alarm()
  await restarted.drain()
  assert.equal(restarted.service.store.getTask(task.taskId).state,'completed')
  assert.deepEqual(order,['foreground','extraction'])
  const [proposal]=restarted.service.memory.list().proposals
  assert.equal(proposal.value,'after lunch')
  assert.equal(restarted.service.memory.list().memories.length,0)
  await restarted.service.command(cmd('memory.proposal.approve',{proposalId:proposal.proposalId,proposalVersion:1}))
  await restarted.drain()
  assert.equal(restarted.service.memory.list().memories[0].value,'after lunch')
  assert.equal(restarted.service.memory.nextDue(),null)
})

test('two devices share committed input, frozen send approval and one durable receipt',async () => {
  const f = fixture({model:{async *stream({messages}) {
    if (!messages.some(m => m.role === 'tool')) {
      yield {type:'tool_call',id:'call',name:'mail_write',arguments:send}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      yield {type:'text_delta',text:'Submitted.'}
      yield {type:'usage',inputTokens:4,outputTokens:2}
      yield {type:'finish',reason:'stop'}
    }
  }}})
  const request = create('Send the reviewed copy.')
  const [a,b] = await Promise.all([f.service.command(request),f.service.command(request)])
  assert.deepEqual(a,b)
  await f.drain()
  const store = f.service.store
  assert.equal(store.getTask(a.taskId).state,'waiting_mail')
  const op = store.snapshot().operations[0]
  assert.equal(op.preview.body,send.body)
  assert.equal(f.writes.length,0)
  await assert.rejects(f.service.command({...request,message:'different'}),{code:'command_id_conflict'})
  const approve = cmd('mail.approve',{operationId:op.operationId,approvalVersion:op.approvalVersion})
  const bookmark = store.cursor()
  await Promise.all([f.service.command(approve),f.service.command(approve)])
  await f.drain()
  assert.equal(f.writes.length,1)
  assert.equal(store.getTask(a.taskId).state,'completed')
  assert.equal(store.getOp(op.operationId).prepared.payload,undefined)
  await assert.rejects(f.service.command({...approve,commandId:crypto.randomUUID()}),{code:'stale_version'})
  assert.ok(store.events(bookmark).some(e => e.type==='mail.updated' && e.state==='succeeded'))
  assert.equal(store.events(0).filter(e=>e.type==='run.started').length,1)
})

test('two live tasks overlap, cancel and steering supersede late model responses independently',async () => {
  const releases = []
  let started = 0
  const f=fixture({model:{async *stream({messages}) {
    if (!messages.some(m=>m.content==='replacement')) {
      started++
      await new Promise(resolve=>releases.push(resolve))
      yield {type:'tool_call',id:'stale',name:'mail_write',arguments:{action:'archive',messageId:'wrong'}}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      yield {type:'text_delta',text:'updated'}
      yield {type:'finish',reason:'stop'}
    }
  }}})
  const [a,b] = await Promise.all([f.service.command(create('first')),f.service.command(create('second'))])
  for (let i=0;i<50 && started<2;i++) await tick()
  assert.equal(started,2)
  await f.service.command(cmd('task.cancel',{taskId:a.taskId,taskVersion:a.taskVersion}))
  await f.service.command(cmd('task.steer',{taskId:b.taskId,taskVersion:b.taskVersion,message:'replacement'}))
  for (const done of releases) done()
  await f.drain()
  assert.equal(f.writes.length,0)
  assert.equal(f.service.store.getTask(a.taskId).state,'cancelled')
  assert.equal(f.service.store.getTask(b.taskId).state,'completed')
})

test('ambiguous send survives retry and restart, requires human evidence, and never resends',async () => {
  let submitted=0
  const f = fixture({mail:{execute:async () => {submitted++; return {status:'unknown',code:'timeout'}}}})
  const request=submit(send)
  const {operations:[op]}=await f.service.command(request)
  await f.service.command(cmd('mail.approve',{operationId:op.operationId,approvalVersion:1}))
  await f.drain()
  const restarted=fixture({storage:f.storage})
  await restarted.service.command(request)
  await restarted.service.host.alarm()
  const unknown=restarted.service.store.getOp(op.operationId)
  assert.equal(unknown.state,'unknown')
  await restarted.service.command(cmd('mail.reconcile',{operationId:op.operationId,approvalVersion:unknown.version,
    outcome:'succeeded',evidence:'User checked sent folder and message body'}))
  await restarted.drain()
  assert.equal(restarted.service.store.getOp(op.operationId).receipt.priorReceipt.code,'timeout')
  assert.equal(submitted,1)
  assert.equal(restarted.writes.length,0)
})

test('crash after durable dispatch intent yields unknown, while accepted queued work resumes on alarm',async () => {
  const f=fixture()
  f.service.host.kick=()=>{}
  const first=await f.service.command(submit({action:'mark_read',messageId:'1'}))
  const second=await f.service.command(submit({action:'archive',messageId:'2'}))
  const op=f.service.store.getOp(first.operations[0].operationId)
  op.state='dispatching'
  f.service.store.tx(()=>f.service.store.saveOp(op))
  const restart=fixture({storage:f.storage})
  await restart.service.host.alarm()
  await restart.drain()
  assert.equal(restart.service.store.getOp(op.id).state,'unknown')
  assert.equal(restart.service.store.getOp(second.operations[0].operationId).state,'succeeded')
  assert.deepEqual(restart.writes.map(p=>p.action),['archive'])
})

test('batch receipts serialize same-resource writes, report stale item without replaying successful items',async () => {
  const f=fixture()
  const command=cmd('mail.submit',{mailboxId:'box',items:['1','1','2'].map(messageId=>({input:{action:'mark_read',messageId},expectedRevision:0}))})
  const response=await f.service.command(command)
  await f.drain()
  const ops=response.operations.map(op=>f.service.store.getOp(op.operationId))
  assert.deepEqual(ops.map(op=>op.state),['succeeded','failed','succeeded'])
  assert.equal(ops[1].receipt.code,'stale_mail_revision')
  await f.service.command(command)
  await f.drain()
  assert.equal(f.writes.length,2)
  assert.equal(ops[2].revision,1)
})

test('each command verifies action grant and scope; schedule waits for its due time and checks epoch again',async () => {
  const f=fixture()
  const when=Date.now()+3600000
  const {operations:[op]}=await f.service.command(cmd('mail.submit',{mailboxId:'box',items:[{input:send,scheduledAt:when}]}))
  await f.service.command(cmd('mail.approve',{operationId:op.operationId,approvalVersion:1}))
  await f.drain()
  assert.equal(f.writes.length,0)
  const stored=f.service.store.getOp(op.operationId)
  stored.scheduledAt=Date.now()-1
  f.service.store.tx(()=>f.service.store.saveOp(stored))
  f.records.box.epoch++
  await f.service.host.alarm()
  await f.drain()
  assert.equal(f.service.store.getOp(op.operationId).state,'failed')
  assert.equal(f.writes.length,0)
  await assert.rejects(f.service.command(submit({action:'create_draft'})),{code:'action_not_granted'})
  await assert.rejects(f.service.command(submit({action:'permanent_delete',messageId:'1'})),{code:'unsupported_action'})
})

test('agent resumes a reconciled send with the verified receipt and no second dispatch',async () => {
  let dispatched=0
  const f=fixture({mail:{execute:async () => {dispatched++; return {status:'unknown',code:'timeout'}}},
    model:{async *stream({messages}) {
      const result=messages.find(m=>m.role==='tool')
      if (!result) {
        yield {type:'tool_call',name:'mail_write',id:'call',arguments:send}
        yield {type:'finish',reason:'tool_calls'}
      } else {
        assert.equal(JSON.parse(result.content).receipt.code,'user_verified')
        yield {type:'text_delta',text:'User verified submission.'}
        yield {type:'finish',reason:'stop'}
      }
    }}})
  const t=await f.service.command(create('Send'))
  await f.drain()
  const op=f.service.store.snapshot().operations[0]
  await f.service.command(cmd('mail.approve',{operationId:op.operationId,approvalVersion:1}))
  await f.drain()
  assert.equal(f.service.store.getTask(t.taskId).state,'needs_review')
  const current=f.service.store.getOp(op.operationId)
  await f.service.command(cmd('mail.reconcile',{operationId:current.id,approvalVersion:current.version,
    outcome:'succeeded',evidence:'Verified in Sent'}))
  await f.drain()
  assert.equal(f.service.store.getTask(t.taskId).state,'completed')
  assert.equal(dispatched,1)
})

test('a new device can find an old pending approval and reconstruct the current stream at its snapshot cursor',async () => {
  const f=fixture()
  const {operations:[pending]}=await f.service.command(submit(send))
  await f.drain()
  const store=f.service.store
  store.tx(()=>{
    const old=store.getOp(pending.operationId)
    for (let i=0;i<55;i++) store.saveOp({...old,id:'finished-'+i,state:'failed'})
    store.event('attempt.started',{messageId:'stream',taskId:'t',runId:'r'})
    store.event('message.delta',{messageId:'stream',taskId:'t',runId:'r',text:'first part'})
  })
  const snapshot=store.snapshot()
  assert.ok(!snapshot.operations.some(op=>op.operationId===pending.operationId))
  assert.ok(snapshot.pendingOperations.some(op=>op.operationId===pending.operationId))
  assert.equal(snapshot.streams[0].text,'first part')
  assert.deepEqual(store.events(snapshot.snapshotCursor),[])
})

test('late provider reads cannot overwrite newer observations from another device',async () => {
  const f=fixture()
  const ctx=await f.service.mail.context('box',1)
  let finish
  const old=f.service.readProvider('mail_read',{messageId:'M'},ctx,()=>new Promise(resolve=>{finish=resolve}))
  const view=(version,text)=>({citation:{mailboxId:'box',messageId:'M'},version,subject:text,preview:text,body:text})
  const fresh=await f.service.readProvider('mail_read',{messageId:'M'},ctx,async()=>view('2','Fresh'))
  assert.equal(fresh.revision,1)
  finish(view('1','Stale'))
  await assert.rejects(old,{code:'stale_mail_revision'})
  let indexed=f.service.index.index.lookup('box','M')
  assert.equal(JSON.parse(indexed.data).subject,'Fresh')
  assert.equal(indexed.id,fresh.citation.messageId)
  const later=await f.service.readProvider('mail_read',{messageId:fresh.citation.messageId},ctx,async()=>view('3','Latest'))
  assert.equal(later.revision,2)
  indexed=f.service.index.index.lookup('box','M')
  assert.equal(JSON.parse(indexed.data).subject,'Latest')
  assert.deepEqual(f.service.store.events(0).filter(e=>e.type==='mail.observed').map(e=>e.providerVersion),['2','3'])
})

test('usage received before a stream failure remains attached to the abandoned attempt',async () => {
  const f=fixture({model:{async *stream(){
    yield {type:'usage',inputTokens:10,cacheReadTokens:3}
    throw Object.assign(Error(),{code:'model_refusal'})
  }}})
  await f.service.command(create('Read recent messages.'))
  await f.drain()
  const attempt=f.service.store.events(0).find(e=>e.type==='attempt.abandoned')
  assert.equal(attempt.usage.inputTokens,10)
  assert.equal(attempt.usage.cacheReadTokens,3)
  assert.equal(attempt.usage.outputTokens,null)
})

test('a confirmed rate limit retries under the same operation ID without replaying an accepted mutation',async () => {
  let attempts=0
  const f=fixture({mail:{execute:async () => ++attempts === 1 ?
    {status:'failed',code:'rate_limited',retryAfterMs:5000} : {status:'succeeded',providerId:'same-message'}}})
  const {operations:[submitted]}=await f.service.command(submit({action:'archive',messageId:'M'}))
  await f.drain()
  const op=f.service.store.getOp(submitted.operationId)
  assert.equal(op.state,'queued')
  assert.ok(op.retryAt>Date.now())
  assert.equal(attempts,1)
  op.retryAt=Date.now()-1
  f.service.store.tx(()=>f.service.store.saveOp(op))
  await f.service.host.alarm()
  await f.drain()
  assert.equal(f.service.store.getOp(submitted.operationId).state,'succeeded')
  assert.equal(attempts,2)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {setImmediate as tick} from 'node:timers/promises'
import {AgentService} from '../src/service.mjs'
import {prepareMailCommand} from '../src/mail/index.mjs'
import {createStorage} from './support/storage.mjs'

const profile={provider:'openai',model:'gpt-test',connectionId:'model'}
const command=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})
const create=message=>command('task.create',{message,modelProfile:profile,mailboxId:'box'})
const send={action:'send',to:['person@example.org'],subject:'Reviewed subject',body:'Reviewed body'}
function gate() {
  let resolve
  const promise=new Promise(done=>{resolve=done})
  return {promise,resolve}
}

function fixture({stream,execute,read,storage=createStorage()}={}) {
  const jobs=new Set()
  const counts={mailCredentials:0,mailReads:0,mailWrites:0,preparationReads:0}
  const records={
    model:{id:'model',kind:'model',provider:'openai',status:'active',epoch:1},
    box:{id:'box',kind:'mail',provider:'gmail',status:'active',epoch:1,
      scopes:['https://www.googleapis.com/auth/gmail.modify'],actions:['send','archive','mark_read']}
  }
  const ctx={storage,waitUntil(promise) {
    jobs.add(promise)
    promise.then(()=>jobs.delete(promise),()=>jobs.delete(promise))
  }}
  const connections={get:id=>records[id],assertEpoch(id,epoch) {
    assert.ok(records[id])
    if(records[id].epoch!==epoch || records[id].status!=='active') {
      throw Object.assign(new Error('connection changed'),{code:'connection_changed',status:409})
    }
  },async credential(id,epoch) {
    this.assertEpoch(id,epoch)
    if(id==='box') counts.mailCredentials++
    return 'fixture-only'
  }}
  const service=new AgentService(ctx,{}, {connections,model:{stream,read:async(...args)=>{
    counts.mailReads++
    if(read) return read(...args)
    assert.fail('History retrieval must not call a mail provider')
  }},mail:{prepare:(input,context)=>prepareMailCommand(input,{...context,fetchImpl:async url=>{
    counts.preparationReads++
    assert.equal(String(url),'https://gmail.googleapis.com/gmail/v1/users/me/profile')
    return Response.json({emailAddress:'sender@example.org'})
  }}),execute:async(prepared,context)=>{
    context.beforeWrite()
    counts.mailWrites++
    return execute ? execute(prepared,context) : {status:'succeeded',providerId:'sent-1'}
  }}})
  return {service,storage,counts,async drain() {
    for(let i=0;i<100;i++) {
      await tick()
      if(!jobs.size) return
      await Promise.all([...jobs])
    }
    assert.fail('Scheduler failed to settle')
  },async retryNow(taskId) {
    const task=service.store.getTask(taskId)
    assert.equal(task.state,'queued')
    task.due=0
    service.store.tx(()=>service.store.saveTask(task,false))
    await service.host.alarm()
    await this.drain()
  }}
}

test('agent searches prior work, reads the cited original and finishes without mail OAuth or provider I/O', {timeout:10000}, async()=>{
  const original='Acme 报价决定。'+ '记录。'.repeat(180)+'最终确认：金额 4800，等待客户回复。'
  let priorId,sourceId
  const seen=[]
  const f=fixture({async *stream({messages,tools}) {
    const input=messages.findLast(message=>message.role==='user').content
    if(input===original) {
      yield {type:'text_delta',text:'已记录。'}
      yield {type:'finish',reason:'stop'}
      return
    }
    assert.ok(tools.some(tool=>tool.name==='history_search'))
    assert.ok(tools.some(tool=>tool.name==='history_read'))
    const results=messages.filter(message=>message.role==='tool')
    if(!results.length) {
      seen.push('search')
      yield {type:'tool_call',id:'history-search',name:'history_search',arguments:{query:'Acme'}}
      yield {type:'finish',reason:'tool_calls'}
    } else if(results.length===1) {
      seen.push('read')
      const result=JSON.parse(results[0].content)
      assert.equal(result.results.length,1)
      assert.equal(result.results[0].taskId,priorId)
      assert.equal(result.results[0].messageId,sourceId)
      yield {type:'tool_call',id:'history-read',name:'history_read',arguments:{taskId:priorId,messageId:sourceId,neighbors:1}}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      seen.push('answer')
      const result=JSON.parse(results[1].content)
      assert.equal(result.taskId,priorId)
      assert.equal(result.messageId,sourceId)
      assert.equal(result.content,original)
      assert.equal(result.nextOffset,null)
      assert.ok(result.neighbors.some(item=>item.content==='已记录。'))
      yield {type:'text_delta',text:'根据历史原文，报价为 4800，仍需要检查最新回复。'}
      yield {type:'finish',reason:'stop'}
    }
  }})
  const prior=await f.service.command(create(original))
  priorId=prior.taskId
  await f.drain()
  sourceId=f.service.store.messages(priorId)[0].messageId
  const next=await f.service.command(create('继续 Acme 报价任务，先核对以前的决定。'))
  await f.drain()
  assert.equal(f.service.store.getTask(next.taskId).state,'completed')
  assert.deepEqual(seen,['search','read','answer'])
  assert.deepEqual(f.counts,{mailCredentials:0,mailReads:0,mailWrites:0,preparationReads:0})
  const messages=f.service.store.messages(next.taskId)
  assert.deepEqual(messages.filter(message=>message.role==='tool').map(message=>message.toolName),['history_search','history_read'])
  assert.ok(messages.filter(message=>message.role==='tool').every(message=>Number.isSafeInteger(message.historyEpoch)))
  assert.equal(messages.at(-1).historyEpoch,f.service.memory.state().epoch)
})

test('a memory deletion during a model request abandons its stale mail write and retries with current references', {timeout:10000}, async()=>{
  const paused=gate(),release=gate()
  let currentCalls=0
  const original='以后用中文回复。Acme 报价需要复核。'
  const f=fixture({async *stream({messages}) {
    const input=messages.findLast(message=>message.role==='user').content
    if(input===original) {
      yield {type:'text_delta',text:'已记录。'}
      yield {type:'finish',reason:'stop'}
      return
    }
    currentCalls++
    if(currentCalls===1) {
      assert.ok(messages.some(message=>message.role==='system' && message.content.includes('response.language')))
      paused.resolve()
      await release.promise
      yield {type:'tool_call',id:'stale-send',name:'mail_write',arguments:send}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      assert.ok(!messages.some(message=>message.role==='system' && message.content.includes('response.language')))
      yield {type:'text_delta',text:'当前记忆已更新；没有发送邮件。'}
      yield {type:'finish',reason:'stop'}
    }
  }})
  await f.service.command(create(original))
  await f.drain()
  const preference=f.service.memory.get('response.language')
  assert.equal(preference.value,'中文')
  const task=await f.service.command(create('请根据 Acme 的历史准备下一步。'))
  await paused.promise
  await f.service.command(command('memory.delete',{key:preference.key,expectedVersion:preference.version}))
  release.resolve()
  await f.drain()
  const retry=f.service.store.getTask(task.taskId)
  assert.equal(retry.state,'queued')
  assert.equal(retry.error,'memory_context_changed')
  assert.equal(f.service.store.rows('SELECT id FROM operations').length,0)
  assert.equal(f.service.store.messages(task.taskId).length,1)
  assert.ok(f.service.store.events(0).some(event=>event.type==='attempt.abandoned'&&event.taskId===task.taskId))
  await f.retryNow(task.taskId)
  assert.equal(f.service.store.getTask(task.taskId).state,'completed')
  assert.equal(currentCalls,2)
  assert.equal(f.counts.mailWrites,0)
  assert.equal(f.counts.mailCredentials,0)
  assert.equal(f.service.store.rows('SELECT id FROM operations').length,0)
})

test('memory invalidation while an approved send settles preserves its receipt and never submits it twice', {timeout:10000}, async()=>{
  const dispatched=gate(),settle=gate()
  let modelCalls=0
  const f=fixture({async execute() {
    dispatched.resolve()
    await settle.promise
    return {status:'succeeded',providerId:'confirmed-send',providerThreadId:'thread-1'}
  },async *stream({messages,tools}) {
    modelCalls++
    const result=messages.find(message=>message.role==='tool' && message.toolName==='mail_write')
    if(!result) {
      yield {type:'tool_call',id:'approved-send',name:'mail_write',arguments:send}
      yield {type:'finish',reason:'tool_calls'}
      return
    }
    assert.ok(!tools.some(tool=>tool.name.startsWith('history_')))
    const receipt=JSON.parse(result.content)
    assert.equal(receipt.status,'succeeded')
    assert.equal(receipt.receipt.providerId,'confirmed-send')
    assert.equal(result.historyEpoch,undefined)
    yield {type:'text_delta',text:'已确认发送。'}
    yield {type:'finish',reason:'stop'}
  }})
  const task=await f.service.command(create('发送已确认的内容。'))
  await f.drain()
  const [approval]=f.service.store.operationPage().operations
  assert.equal(approval.state,'waiting_approval')
  assert.equal(f.service.store.getTask(task.taskId).state,'waiting_mail')
  await f.service.command(command('mail.approve',{operationId:approval.operationId,approvalVersion:approval.approvalVersion}))
  await dispatched.promise
  await f.service.command(command('memory.configure',{enabled:false,expectedVersion:1}))
  settle.resolve()
  await f.drain()
  assert.equal(f.service.store.getTask(task.taskId).state,'completed')
  assert.equal(f.service.store.getOp(approval.operationId).receipt.providerId,'confirmed-send')
  assert.equal(f.service.store.rows('SELECT id FROM operations').length,1)
  assert.equal(f.counts.mailWrites,1)
  assert.equal(modelCalls,2)
  f.service.host.kick()
  await f.drain()
  assert.equal(f.counts.mailWrites,1)
  const receipts=f.service.store.messages(task.taskId).filter(message=>message.role==='tool'&&message.toolName==='mail_write')
  assert.equal(receipts.length,1)
  assert.equal(JSON.parse(receipts[0].content).receipt.providerId,'confirmed-send')
})

test('deleting a personal preference also excludes an assistant echo generated from that reference', {timeout:10000}, async()=>{
  const f=fixture({async *stream() {
    yield {type:'text_delta',text:'MarigoldStyle is the preferred writing style.'}
    yield {type:'finish',reason:'stop'}
  }})
  await f.service.command(command('memory.upsert',{key:'writing.style',value:'MarigoldStyle'}))
  const task=await f.service.command(create('What writing style should this reply use?'))
  await f.drain()
  const answer=f.service.store.messages(task.taskId).at(-1)
  assert.equal(answer.historyEpoch,f.service.memory.state().epoch)
  await f.service.command(command('memory.delete',{key:'writing.style',expectedVersion:1}))
  await f.drain()
  const result=f.service.memory.history.search({query:'MarigoldStyle'},{mailboxId:'box'})
  assert.deepEqual(result.results,[])
  assert.throws(()=>f.service.memory.history.read({taskId:task.taskId,messageId:answer.messageId},{mailboxId:'box'}),{code:'history_source_not_found'})
})

test('a memory change during a mixed local-history and mail-read batch does not commit stale recall', {timeout:10000}, async()=>{
  const paused=gate(),release=gate()
  const original='Acme historic quote was 4800.'
  let currentCalls=0
  const f=fixture({async read(name) {
    assert.equal(name,'mail_search')
    paused.resolve()
    await release.promise
    return {matches:[]}
  },async *stream({messages,tools}) {
    const input=messages.findLast(message=>message.role==='user').content
    if(input===original) {
      yield {type:'text_delta',text:'Recorded.'}
      yield {type:'finish',reason:'stop'}
      return
    }
    currentCalls++
    if(currentCalls===1) {
      yield {type:'tool_call',id:'local-search',name:'history_search',arguments:{query:'Acme'}}
      yield {type:'tool_call',id:'live-search',name:'mail_search',arguments:{query:'Acme',limit:1}}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      assert.ok(!tools.some(tool=>tool.name==='history_search'))
      yield {type:'text_delta',text:'Historical recall was disabled.'}
      yield {type:'finish',reason:'stop'}
    }
  }})
  await f.service.command(create(original))
  await f.drain()
  const task=await f.service.command(create('Find Acme history and check current messages.'))
  await paused.promise
  await f.service.command(command('memory.configure',{enabled:false,expectedVersion:1}))
  release.resolve()
  await f.drain()
  const retry=f.service.store.getTask(task.taskId)
  assert.equal(retry.state,'queued')
  assert.equal(retry.error,'memory_context_changed')
  const historicalResults=f.service.store.messages(task.taskId).filter(message=>message.toolName==='history_search')
  assert.equal(historicalResults.length,1)
  assert.ok(!historicalResults[0].content.includes(original))
  await f.retryNow(task.taskId)
  assert.equal(f.service.store.getTask(task.taskId).state,'completed')
  assert.equal(f.counts.mailReads,1)
  assert.equal(f.counts.mailWrites,0)
})

test('steering while a summary is pending rejects the old checkpoint and runs only the replacement task', {timeout:10000}, async()=>{
  const paused=gate(),release=gate()
  let summaries=0,foreground=0
  const f=fixture({async *stream({messages,tools}) {
    if(!tools.length) {
      summaries++
      if(summaries===1) {
        paused.resolve()
        await release.promise
        yield {type:'text_delta',text:'STALE_CHECKPOINT_DO_NOT_COMMIT'}
      } else {
        yield {type:'text_delta',text:'Earlier notes concern an unexecuted mail task. No mail has been sent. Read the latest user instruction before continuing; preserve the original message IDs when exact details matter.'}
      }
      yield {type:'finish',reason:'stop'}
      return
    }
    foreground++
    assert.ok(messages.some(message=>message.role==='user'&&message.content==='Replacement: summarize the current state only.'))
    assert.ok(!JSON.stringify(messages).includes('STALE_CHECKPOINT_DO_NOT_COMMIT'))
    yield {type:'text_delta',text:'Replacement task completed without mail actions.'}
    yield {type:'finish',reason:'stop'}
  }})
  const kick=f.service.host.kick.bind(f.service.host)
  f.service.host.kick=()=>{}
  const created=await f.service.command(create('Original task: inspect old notes.'))
  const original=f.service.store.getTask(created.taskId)
  f.service.store.tx(()=>{
    for(let i=0;i<32;i++) f.service.store.appendMessage(original,{role:'assistant',content:'Earlier note '+i+': '+ 'Details about the prior task. '.repeat(70)})
  })
  const before=f.service.store.rows('SELECT data FROM messages WHERE task=? ORDER BY n',created.taskId)
  f.service.host.kick=kick
  await f.service.host.alarm()
  await paused.promise
  const replacement=await f.service.command(command('task.steer',{taskId:created.taskId,
    taskVersion:f.service.store.getTask(created.taskId).version,message:'Replacement: summarize the current state only.'}))
  release.resolve()
  await f.drain()
  const current=f.service.store.getTask(created.taskId)
  assert.equal(current.state,'completed')
  assert.equal(current.runId,replacement.runId)
  assert.notEqual(current.runId,original.runId)
  assert.equal(foreground,1)
  assert.ok(summaries>=2&&summaries<=3)
  assert.ok(current.compactionAttempts<=2)
  const checkpoint=f.service.compaction.checkpoint(created.taskId,f.service.memory.state().epoch)
  assert.ok(checkpoint)
  assert.ok(!checkpoint.text.includes('STALE_CHECKPOINT_DO_NOT_COMMIT'))
  const after=f.service.store.rows('SELECT data FROM messages WHERE task=? ORDER BY n',created.taskId)
  assert.deepEqual(after.slice(0,before.length),before)
  assert.equal(after.length,before.length+2)
  assert.equal(f.counts.mailWrites,0)
})

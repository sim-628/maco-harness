import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.mjs'
import {CompactionService} from '../src/model/compaction.mjs'
import {groupMessages} from '../src/model/context.mjs'
import {ModelError} from '../src/model/stream.mjs'
import {createStorage} from './support/storage.mjs'

const summaryText='Goal: follow up the Acme quote. Decisions: retain the agreed price. Pending: inspect the newest reply; no send has been approved.'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(t,{stream,options={}}={}) {
  const storage=createStorage();t.after(()=>storage.close())
  const store=new Store(storage)
  const task={id:'task',runId:'run',state:'running',version:1,createdAt:1,runStartedAt:2,timeZone:'UTC',
    profile:{provider:'openai',model:'gpt-4.1',connectionId:'model',effort:'provider-default'}}
  store.saveTask(task)
  const requests=[]
  const service=new CompactionService(store,{maxInputBytes:8192,retainBytes:1100,maxSummaryBytes:1500,
    stream:stream || (async function*(args){requests.push(args);yield {type:'text_delta',text:summaryText};
      yield {type:'usage',inputTokens:1800,outputTokens:40,cacheReadTokens:10};yield {type:'finish',reason:'stop'}}),...options})
  const append=message=>store.appendMessage(task,message)
  const ensure=()=>{if(store.getTask(task.id).runId!==task.runId || store.getTask(task.id).state!=='running') throw new ModelError('run_superseded')}
  let attempts=0
  const prepare=(extra={})=>service.prepare(task,{credential:{apiKey:'fixture'},signal:new AbortController().signal,
    assertCurrent:ensure,beforeSummary:()=>{attempts++},...extra})
  return {storage,store,task,service,requests,append,prepare,get attempts(){return attempts}}
}
function history(f,count=18) {
  f.append({role:'user',content:'Follow up the Acme quote, preserve the agreed price.'})
  for(let i=0;i<count;i++) f.append({role:'assistant',content:'Earlier result '+i+': '+('Evidence about the quote. '.repeat(22))})
  f.append({role:'user',content:'Check the latest reply, but do not send anything yet.'})
  f.append({role:'assistant',content:'The next action is to inspect the latest message.'})
}

test('short tasks use no extra model call and oversized tool text is pruned before summarizing',async t=>{
  const f=fixture(t,{options:{maxInputBytes:16384,retainBytes:2000,maxSummaryBytes:1500}})
  f.append({role:'user',content:'Find the Acme quote.'})
  const simple=await f.prepare()
  assert.equal(simple.compacted,0);assert.equal(f.requests.length,0)
  const calls=[{id:'left',name:'mail_read',arguments:{messageId:'A'}},{id:'right',name:'mail_read',arguments:{messageId:'B'}}]
  f.append({role:'assistant',content:'',toolCalls:calls})
  const original='Beginning of receipt. '+ 'X'.repeat(22000)+' End of receipt.'
  f.append({role:'tool',toolCallId:'right',content:original})
  f.append({role:'tool',toolCallId:'left',content:'Quote confirmed.'})
  const result=await f.prepare()
  assert.equal(f.requests.length,0)
  assert.ok(result.warnings.includes('context_tool_results_pruned'))
  assert.ok(result.messages.some(m=>m.content?.includes('shortened for context')))
  assert.ok(result.messages.some(m=>m.content?.endsWith('End of receipt.')))
  assert.equal(f.store.messages('task').find(m=>m.toolCallId==='right').content,original)
  assert.doesNotThrow(()=>groupMessages(result.messages.filter(m=>m.role!=='system')))
})

test('tool evidence longer than the preview limit stays complete below the pressure threshold',async t=>{
  const f=fixture(t,{options:{maxInputBytes:16384,retainBytes:2000,maxSummaryBytes:1500}})
  f.append({role:'user',content:'Read this entire letter.'})
  f.append({role:'assistant',content:'',toolCalls:[{id:'read',name:'mail_read',arguments:{messageId:'letter'}}]})
  const body='The complete letter. '+ 'X'.repeat(6000)+' End of letter.'
  f.append({role:'tool',toolCallId:'read',content:body})
  const result=await f.prepare()
  assert.equal(f.requests.length,0)
  assert.equal(result.messages.find(m=>m.toolCallId==='read').content,body)
  assert.ok(!result.warnings.includes('context_tool_results_pruned'))
})

test('durable checkpoints preserve goal, latest steering, original history and complete tool pairs',async t=>{
  const f=fixture(t)
  history(f)
  const calls=[{id:'a',name:'mail_read',arguments:{messageId:'quote-1'}},{id:'b',name:'mail_read',arguments:{messageId:'reply-2'}}]
  f.append({role:'assistant',content:'',toolCalls:calls,providerState:{provider:'anthropic',blocks:[{thinking:'PRIVATE_NATIVE_STATE'}]}})
  f.append({role:'tool',toolCallId:'b',content:'Latest reply: requested delivery date.'})
  f.append({role:'tool',toolCallId:'a',content:'Quote: price unchanged.'})
  const raw=f.store.rows('SELECT n,data FROM messages ORDER BY n')
  const result=await f.prepare()
  assert.ok(result.compacted>0);assert.ok(result.checkpoint.throughN>0)
  assert.ok(result.messages.some(m=>m.content==='Follow up the Acme quote, preserve the agreed price.'))
  assert.ok(result.messages.some(m=>m.content==='Check the latest reply, but do not send anything yet.'))
  assert.ok(result.messages.some(m=>m.content?.includes(summaryText)))
  assert.doesNotThrow(()=>groupMessages(result.messages.filter(m=>m.role!=='system')))
  assert.deepEqual(f.store.rows('SELECT n,data FROM messages ORDER BY n'),raw)
  for(const request of f.requests) {
    assert.deepEqual(request.tools,[]);assert.equal(request.profile,f.task.profile)
    assert.equal(request.credential.apiKey,'fixture')
    assert.ok(!JSON.stringify(request.messages).includes('PRIVATE_NATIVE_STATE'))
  }
  const events=f.store.events(0,1000).filter(e=>e.type==='context.compaction_finished')
  assert.equal(events.length,result.compacted);assert.equal(events[0].usage.inputTokens,1800)
  assert.equal(events[0].usage.cacheReadTokens,10)
  const reloaded=new CompactionService(new Store(f.storage),{stream:async function*(){throw new Error('unexpected')}})
  assert.equal(reloaded.checkpoint('task').text,result.checkpoint.text)
  assert.equal(reloaded.view('task').text,undefined)
})

test('summary source includes balanced calls and excludes native provider state',async t=>{
  const f=fixture(t,{options:{maxInputBytes:16384,retainBytes:1500,maxSummaryBytes:1500}})
  f.append({role:'user',content:'Inspect these quotes.'})
  for(let i=0;i<18;i++) {
    f.append({role:'assistant',content:'',toolCalls:[{id:'c'+i,name:'mail_read',arguments:{messageId:'M'+i}}],
      providerState:{reasoningContent:'SECRET_NATIVE_STATE'}})
    f.append({role:'tool',toolCallId:'c'+i,content:'Quote detail '+i+': '+'Evidence '.repeat(90)})
  }
  f.append({role:'user',content:'Keep the most recent quote.'})
  const result=await f.prepare()
  assert.ok(result.compacted>0)
  for(const request of f.requests) {
    const data=JSON.parse(request.messages[1].content)
    assert.doesNotThrow(()=>groupMessages(data.records))
    assert.ok(!request.messages[1].content.includes('SECRET_NATIVE_STATE'))
  }
})

test('summary failures leave raw log and checkpoint unchanged, disclose omissions and do not immediately rebill',async t=>{
  let count=0
  const f=fixture(t,{stream:async function*(){count++;yield {type:'usage',inputTokens:23,outputTokens:3};throw new ModelError('model_transport_error')}})
  history(f,35)
  const before=f.store.rows('SELECT data FROM messages ORDER BY n')
  const first=await f.prepare()
  assert.equal(first.failed,true);assert.equal(first.truncated,true);assert.equal(first.checkpoint,null)
  assert.ok(first.messages.some(m=>m.content?.includes('Maco context coverage')))
  assert.equal(count,1)
  await f.prepare()
  f.append({role:'assistant',content:'New small step.'})
  await f.prepare()
  assert.equal(count,1)
  assert.deepEqual(f.store.rows('SELECT data FROM messages ORDER BY n').slice(0,before.length),before)
  const error=f.store.events(0,1000).find(e=>e.type==='context.compaction_failed')
  assert.equal(error.code,'model_transport_error');assert.equal(error.usage.inputTokens,23)
})

test('a durable unfinished attempt is not recharged after process reconstruction',async t=>{
  const f=fixture(t)
  history(f)
  const head=f.service.head('task').n
  f.store.rows('INSERT INTO task_context_attempts VALUES (?,?)','task',JSON.stringify({id:'crashed',runId:'run',head,
    throughN:0,status:'running',retryAt:0,usage:{inputTokens:10}}))
  const result=await f.prepare()
  assert.equal(f.requests.length,0);assert.ok(result.warnings.includes('context_compaction_cooldown'))
  assert.equal(result.checkpoint,null)
})

test('steering, cancellation and privacy changes cannot commit an asynchronously generated checkpoint',async t=>{
  for(const change of ['steer','cancel','memory']) {
    const ready=deferred(),release=deferred()
    const f=fixture(t,{stream:async function*(){ready.resolve();await release.promise;yield {type:'text_delta',text:summaryText};yield {type:'finish',reason:'stop'}}})
    history(f)
    let epoch=1
    const controller=new AbortController()
    const pending=f.prepare({signal:controller.signal,memoryEpoch:epoch,getMemoryEpoch:()=>epoch})
    await ready.promise
    if(change==='steer'){const task=f.store.getTask('task');task.runId='replacement';f.store.saveTask(task)}
    if(change==='cancel') controller.abort()
    if(change==='memory') epoch=2
    release.resolve()
    await assert.rejects(pending)
    assert.equal(f.service.checkpoint('task',1),null)
  }
})

test('invalid summary outcomes never create a checkpoint',async t=>{
  for(const variant of ['empty','length','tool','large']) {
    const f=fixture(t,{stream:async function*(){
      if(variant==='tool') yield {type:'tool_call',name:'mail_write',id:'bad',arguments:{}}
      if(variant==='large') yield {type:'text_delta',text:'X'.repeat(2000)}
      if(variant==='length') yield {type:'text_delta',text:'unfinished'}
      yield {type:'finish',reason:variant==='length'?'length':'stop'}
    }})
    history(f)
    const result=await f.prepare()
    assert.equal(result.compacted,0);assert.equal(result.failed,true);assert.equal(result.checkpoint,null)
    assert.equal(f.store.rows('SELECT * FROM task_context_checkpoints').length,0)
  }
})

test('a checkpoint that does not shrink its source is rejected without replacing history',async t=>{
  const f=fixture(t,{options:{triggerRatio:0.35,retainBytes:250,maxSummaryBytes:3500},
    stream:async function*(){yield {type:'text_delta',text:'X'.repeat(3000)};yield {type:'finish',reason:'stop'}}})
  f.append({role:'user',content:'Inspect the quote.'})
  for(let i=0;i<10;i++)f.append({role:'assistant',content:'Evidence '+i+' '+ 'x'.repeat(160)})
  const result=await f.prepare()
  assert.equal(result.checkpoint,null)
  assert.ok(result.warnings.includes('compaction_did_not_shrink'))
  assert.equal(f.store.messages('task').length,11)
})

test('histories larger than one page advance bounded checkpoints and explicitly report remaining gaps',async t=>{
  const f=fixture(t)
  history(f,310)
  const rows=f.store.rows.bind(f.store)
  f.store.rows=(sql,...args)=>{assert.ok(args.length<=100,'DO query binding budget');return rows(sql,...args)}
  const first=await f.prepare()
  assert.equal(first.compacted,2);assert.ok(first.checkpoint.throughN>0)
  assert.equal(first.truncated,true);assert.equal(first.coverage.complete,false)
  assert.ok(first.messages.some(m=>m.content?.includes('Some older task messages')))
  const second=await f.prepare()
  assert.equal(second.compacted,2);assert.ok(second.checkpoint.throughN>first.checkpoint.throughN)
  assert.equal(f.requests.length,4)
  assert.ok(f.requests.every(request=>Buffer.byteLength(JSON.stringify(request.messages))<8192))
})

test('memory epoch invalidates checkpoints and summary input uses the trusted message projector',async t=>{
  const f=fixture(t)
  history(f)
  const tagged=f.append({role:'assistant',content:'Old recalled preference: REDACT_ME',historyEpoch:1})
  for(let i=0;i<12;i++)f.append({role:'assistant',content:'Follow-up evidence '+i+' '+ 'More detail. '.repeat(40)})
  let epoch=1
  const projectMessage=message=>message.historyEpoch!==undefined && message.historyEpoch!==epoch
    ? {...message,content:'Historical reference is no longer available.',providerState:undefined} : message
  const first=await f.prepare({memoryEpoch:epoch,projectMessage})
  // Force subsequent preparation until the tagged row is included in a checkpoint.
  let latest=first
  for(let i=0;i<4 && !latest.checkpoint?.containsHistory;i++)latest=await f.prepare({memoryEpoch:epoch,projectMessage})
  assert.equal(latest.checkpoint.containsHistory,true)
  assert.equal(f.service.checkpoint('task',2),null)
  epoch=2
  const start=f.requests.length
  const next=await f.prepare({memoryEpoch:epoch,projectMessage})
  assert.equal(next.checkpoint.memoryEpoch,2)
  assert.ok(f.requests.slice(start).every(request=>!JSON.stringify(request.messages).includes('REDACT_ME')))
  assert.ok(!JSON.stringify(next.messages).includes('REDACT_ME'))
  assert.equal(f.store.messages('task',200).find(m=>m.messageId===tagged.messageId).content,'Old recalled preference: REDACT_ME')
})

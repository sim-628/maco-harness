import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.mjs'
import {MemoryService} from '../src/memory/index.mjs'
import {HISTORY_TOOLS} from '../src/history/index.mjs'
import {validateTool} from '../src/tool-policy.mjs'
import {createStorage} from './support/storage.mjs'

function fixture() {
  const storage=createStorage(),store=new Store(storage),memory=new MemoryService(store)
  const tasks=new Map()
  const task=(id,mailboxId='box')=>{
    const value={id,runId:'run-'+id,mailboxId,state:'completed',createdAt:1000,due:0,version:1}
    store.saveTask(value,false);tasks.set(id,value);return value
  }
  const add=(taskId,role,content,fields={})=>{
    const t=tasks.get(taskId) || task(taskId)
    return store.tx(()=>store.appendMessage(t,{role,content,...fields}))
  }
  const scope={callerTaskId:'current',mailboxId:'box'}
  return {storage,store,memory,history:memory.history,task,add,scope}
}

test('cross-task search groups by task, supports Han keywords, and centers excerpts beyond the former 12K prefix',()=>{
  const f=fixture()
  const long=f.add('old','user','普通背景 '.repeat(3000)+'报销凭证已交给 Acme 财务部。'+' 尾部'.repeat(300))
  f.add('old','assistant','Acme 报销的后续事项')
  f.add('another','user','Acme 报销等待批准')
  f.add('current','user','Acme 报销')
  const across=f.history.search({query:'Acme 报销'},f.scope)
  assert.deepEqual(new Set(across.results.map(hit=>hit.taskId)),new Set(['old','another']))
  assert.equal(across.coverage.hasMore,false)
  const inside=f.history.search({query:'凭证',taskId:'old'},f.scope)
  assert.equal(inside.results[0].messageId,long.messageId)
  assert.ok(inside.results[0].offset>12000)
  assert.ok(inside.results[0].content.includes('报销凭证'))
  const read=f.history.read({taskId:'old',messageId:long.messageId,offset:inside.results[0].offset},f.scope)
  assert.ok(read.content.includes('报销凭证'))
  assert.equal(read.content,[...long.content].slice(read.offset,read.offset+[...read.content].length).join(''))
})

test('reads continue through the complete public text with exact Unicode offsets and a fixed byte budget',()=>{
  const f=fixture(),content=('资料 😀 "line"\n').repeat(5000)+'最终核对完成'
  const source=f.add('old','assistant',content,{providerState:{apiKey:'must-not-leak',reasoning:'hidden'}})
  let offset=0,restored='',reads=0
  do {
    const result=f.history.read({taskId:'old',messageId:source.messageId,offset},f.scope)
    assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=12000)
    assert.ok(!JSON.stringify(result).includes('must-not-leak'))
    assert.ok(!JSON.stringify(result).includes('hidden'))
    assert.ok(!result.content.includes('\uFFFD'))
    restored+=result.content
    offset=result.nextOffset
    assert.ok(++reads<100)
  } while(offset!==null)
  assert.equal(restored,content)
  const hit=f.history.search({query:'资料'},f.scope).results[0]
  assert.equal(hit.indexTruncated,true)
  assert.ok(hit.sourceChars>hit.indexedChars)
  const last=f.history.read({taskId:'old',messageId:source.messageId,offset:[...content].length},f.scope)
  assert.equal(last.content,'')
  assert.equal(last.nextOffset,null)
  assert.throws(()=>f.history.read({taskId:'old',messageId:source.messageId,offset:[...content].length+1},f.scope),{code:'invalid_history_offset'})
})

test('authenticated store, mailbox scope, and caller-step cutoff apply to search and exact reads',()=>{
  const alice=fixture(),bob=fixture()
  const own=alice.add('current','user','invoice original')
  const boundary=alice.store.one('SELECT MAX(n)+1 AS n FROM messages').n
  const later=alice.add('current','assistant','invoice current tool step')
  alice.task('elsewhere','private-box')
  const other=alice.add('elsewhere','user','invoice private mailbox')
  const scope={...alice.scope,beforeN:boundary}
  assert.deepEqual(alice.history.search({query:'invoice'},scope).results,[])
  assert.deepEqual(alice.history.search({query:'invoice',taskId:'current'},scope).results.map(h=>h.messageId),[own.messageId])
  assert.throws(()=>alice.history.read({taskId:'current',messageId:later.messageId},scope),{code:'history_source_not_found'})
  assert.throws(()=>alice.history.read({taskId:'elsewhere',messageId:other.messageId},scope),{code:'history_source_not_found'})
  assert.deepEqual(bob.history.search({query:'invoice'},bob.scope).results,[])
  assert.throws(()=>bob.history.read({taskId:'current',messageId:own.messageId},bob.scope),{code:'history_source_not_found'})
  assert.throws(()=>alice.history.search({query:'invoice',userId:'bob'},scope),{code:'invalid_tool_arguments'})
})

test('excluded, disabled, and old-epoch evidence cannot return through exact reads or neighboring summaries',()=>{
  const f=fixture()
  const secret=f.add('old','user','以后用中文回复。')
  f.memory.observe('old',secret.messageId)
  const target=f.add('old','assistant','Invoice evidence stays available')
  const echo=f.add('old','assistant','I remember your 中文 preference',{historyEpoch:f.memory.state().epoch})
  f.memory.syncHistory()
  f.memory.remove({key:'response.language',expectedVersion:1})
  const result=f.history.read({taskId:'old',messageId:target.messageId,neighbors:2},f.scope)
  assert.deepEqual(result.neighbors,[])
  for(const message of [secret,echo]) assert.throws(()=>f.history.read({taskId:'old',messageId:message.messageId},f.scope),{code:'history_source_not_found'})
  assert.deepEqual(f.history.search({query:'中文'},f.scope).results,[])
  f.memory.configure({enabled:false,expectedVersion:1})
  assert.deepEqual(f.history.search({query:'Invoice'},f.scope).results,[])
  assert.throws(()=>f.history.read({taskId:'old',messageId:target.messageId},f.scope),{code:'history_source_not_found'})
  f.add('old','user','invoice while disabled')
  f.memory.configure({enabled:true,expectedVersion:2})
  assert.throws(()=>f.history.read({taskId:'old',messageId:target.messageId},f.scope),{code:'history_source_not_found'})
  const fresh=f.add('fresh','user','invoice after enabling')
  assert.deepEqual(f.history.search({query:'invoice'},f.scope).results.map(hit=>hit.messageId),[fresh.messageId])
})

test('mail history uses selected metadata and receipts; retrieval echoes, attachments, credentials and native state stay out',()=>{
  const f=fixture()
  f.add('old','assistant','',{toolCalls:[{id:'write-1',name:'mail_write',arguments:{action:'reply',messageId:'mail-1',body:'outbound secret body',subject:'Acme invoice'}}]})
  const receipt=f.add('old','tool',JSON.stringify({operationId:'op-1',status:'succeeded',receipt:{status:'succeeded',providerId:'mail-sent',accepted:true,accessToken:'token-must-not-leak'}}),{toolCallId:'write-1'})
  const read=f.add('old','tool',JSON.stringify({citation:{mailboxId:'box',messageId:'mail-2'},subject:'Invoice query',preview:'approved amount',body:'private full email body',credentials:{accessToken:'never'}}),{toolName:'mail_read',toolCallId:'read-1'})
  const echo=f.add('old','tool','invoice original secret',{toolName:'history_read',toolCallId:'h-1'})
  const attachment=f.add('old','tool',JSON.stringify({text:'invoice attachment secret'}),{toolName:'mail_read_attachment',toolCallId:'a-1'})
  const found=f.history.search({query:'Acme'},f.scope)
  assert.equal(found.results[0].messageId,receipt.messageId)
  const output=f.history.read({taskId:'old',messageId:receipt.messageId},f.scope)
  assert.ok(output.content.includes('mail-sent'))
  assert.ok(output.content.includes('reply'))
  assert.ok(!output.content.includes('token-must-not-leak'))
  assert.ok(!output.content.includes('outbound secret body'))
  const mail=f.history.read({taskId:'old',messageId:read.messageId},f.scope)
  assert.equal(mail.projection,'mail_metadata')
  assert.equal(mail.projectionLimited,true)
  assert.ok(mail.content.includes('mail-2'))
  assert.ok(!mail.content.includes('private full email body'))
  for(const item of [echo,attachment]) assert.throws(()=>f.history.read({taskId:'old',messageId:item.messageId},f.scope),{code:'history_source_not_found'})
})

test('known pasted credential forms are redacted before indexing and bounded reads',()=>{
  const f=fixture()
  const source=f.add('old','user','invoice API key: sk-abcdefghijklmnopqrstuvwxyz; password="swordfish"; Bearer abcdefghijklmnopqrstuvwx')
  const result=f.history.read({taskId:'old',messageId:source.messageId},f.scope)
  assert.equal(result.redacted,true)
  for(const value of ['sk-abcdefghijklmnopqrstuvwxyz','swordfish','abcdefghijklmnopqrstuvwx']) assert.ok(!JSON.stringify(result).includes(value))
  assert.deepEqual(f.history.search({query:'swordfish'},f.scope).results,[])
  assert.equal(f.history.search({query:'invoice'},f.scope).results.length,1)
})

test('literal query data cannot execute FTS syntax; search caps require narrowing and schemas reject untrusted controls',()=>{
  const f=fixture()
  for(let i=0;i<12;i++) f.add('task-'+i,'user','invoice '+i)
  f.add('salary','user','salary compensation')
  assert.deepEqual(f.history.search({query:'invoice OR salary'},f.scope).results,[])
  const capped=f.history.search({query:'invoice'},f.scope)
  assert.equal(capped.results.length,8)
  assert.equal(capped.capped,true)
  assert.ok(capped.hint)
  assert.throws(()=>f.history.search({query:'word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11 word12 word13 word14 word15 word16 word17'},f.scope),{code:'history_query_too_broad'})
  assert.throws(()=>validateTool(HISTORY_TOOLS[0].inputSchema,{query:'invoice',limit:100000}),{code:'invalid_tool_arguments'})
  assert.throws(()=>validateTool(HISTORY_TOOLS[1].inputSchema,{taskId:'x',messageId:'y',neighbors:3}),{code:'invalid_tool_arguments'})
})

test('derived-index upgrades preserve source messages and incrementally replace old truncated FTS rows',()=>{
  const storage=createStorage(),store=new Store(storage)
  const source=store.appendMessage({id:'old',runId:'old-run'},{role:'user',content:'old padding '.repeat(1500)+'migrationneedle'})
  store.rows('CREATE TABLE memory_state(singleton INTEGER PRIMARY KEY,data TEXT NOT NULL)')
  store.rows('INSERT INTO memory_state VALUES (1,?)',JSON.stringify({enabled:true,extractionMode:'explicit',version:1,epoch:1,historyCursor:1,historyFloor:0,forgetBeforeN:0}))
  store.rows('CREATE TABLE memory_history(n INTEGER PRIMARY KEY,messageId TEXT UNIQUE NOT NULL,taskId TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,tokens TEXT NOT NULL)')
  store.rows("CREATE VIRTUAL TABLE memory_history_fts USING fts5(tokens,content='memory_history',content_rowid='n')")
  store.rows('INSERT INTO memory_history VALUES (1,?,?,?,?,?)',source.messageId,'old','user','old padding','old padding')
  store.rows('INSERT INTO memory_history_fts(rowid,tokens) VALUES (1,?)','old padding')
  const memory=new MemoryService(store)
  assert.equal(memory.state().historyCursor,0)
  assert.equal(memory.searchHistory('migrationneedle').results[0].messageId,source.messageId)
  assert.equal(store.messages('old')[0].content,source.content)
  assert.equal(store.one('SELECT COUNT(*) AS count FROM memory_history').count,1)
  assert.equal(new MemoryService(store).state().historyCursor,1)
})

test('bounded backfill reports incomplete coverage and resumes until late sources are searchable',()=>{
  const f=fixture()
  for(let i=0;i<270;i++) f.add('task-'+i,'user',i===269?'lateunique':'ordinary message')
  const first=f.history.search({query:'lateunique'},f.scope)
  assert.deepEqual(first.results,[])
  assert.equal(first.coverage.hasMore,true)
  assert.equal(first.coverage.indexedThrough,256)
  const second=new MemoryService(f.store).history.search({query:'lateunique'},f.scope)
  assert.equal(second.coverage.hasMore,false)
  assert.equal(second.results[0].taskId,'task-269')
})

test('source-time filters use explicit timezone bounds and reject invalid ranges',()=>{
  const f=fixture(),start=Date.parse('2026-11-18T00:00:00Z')
  f.add('before','user','invoice before',{createdAt:start-1})
  const inside=f.add('within','user','invoice in range',{createdAt:start})
  f.add('after','user','invoice after',{createdAt:start+1000})
  const result=f.history.search({query:'invoice',after:'2026-11-18T08:00:00+08:00',before:'2026-11-18T00:00:01Z'},f.scope)
  assert.deepEqual(result.results.map(hit=>hit.messageId),[inside.messageId])
  assert.equal(result.results[0].createdAt,start)
  assert.throws(()=>f.history.search({query:'invoice',after:'2026-11-18T00:00:00'},f.scope),{code:'invalid_tool_arguments'})
  assert.throws(()=>f.history.search({query:'invoice',after:'2026-11-18T00:00:01Z',before:'2026-11-18T00:00:00Z'},f.scope),{code:'invalid_history_time_range'})
})

test('common terms bound candidate materialization and explicitly report grouping coverage limits',()=>{
  const f=fixture()
  for(let i=0;i<150;i++) f.add('prolific','user','invoice')
  f.add('another','user','invoice '+ 'unrelated padding '.repeat(100))
  const result=f.history.search({query:'invoice'},f.scope)
  assert.equal(result.results.length,1)
  assert.equal(result.results[0].taskId,'prolific')
  assert.equal(result.coverage.candidateLimited,true)
  assert.equal(result.capped,true)
  assert.match(result.hint,/Narrow/u)
})

test('automatic context reserves useful history space alongside a large preference collection',()=>{
  const f=fixture()
  for(let i=0;i<20;i++) f.memory.upsert({key:'mail.preference'+i,value:'偏好'.repeat(150)})
  const source=f.add('old','user','Acme invoice was reviewed yesterday.')
  f.add('current','user','Acme invoice')
  const context=f.memory.context('current',{mailboxId:'box',maxBytes:6000})
  assert.ok(context.preferences.length>0)
  assert.equal(context.relatedHistory[0].messageId,source.messageId)
  assert.ok(new TextEncoder().encode(JSON.stringify(context)).length<=6000)
})

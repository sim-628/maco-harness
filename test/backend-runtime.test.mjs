import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { AgentService } from '../src/service.mjs'
import { createStorage } from './support/storage.mjs'

const profile={provider:'openai',model:'fixture-model',connectionId:'model'}
const cmd=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})
function fixture(t,{stream,read,env={},fetcher,storage=createStorage()}={}) {
  t.after(()=>storage.close())
  const pending=new Set()
  const records={model:{id:'model',kind:'model',provider:'openai',epoch:1,status:'active'}}
  for (const id of ['a','b']) records[id]={id,kind:'mail',provider:'gmail',epoch:1,status:'active',actions:['mark_read'],scopes:['https://www.googleapis.com/auth/gmail.modify']}
  const connections={get:id=>records[id],assertEpoch(id,epoch){assert.equal(records[id]?.epoch,epoch);assert.equal(records[id]?.status,'active')},
    async credential(id,epoch){this.assertEpoch(id,epoch);return 'test-only'}}
  const service=new AgentService({storage,waitUntil(p){pending.add(p);p.finally(()=>pending.delete(p)).catch(()=>{})}},env,
    {connections,model:{stream,read},fetcher})
  async function drain() {
    for(let i=0;i<100;i++) {await tick();if(!pending.size)return;await Promise.all([...pending])}
    assert.fail('background work did not settle')
  }
  return {service,records,storage,drain,create:fields=>service.command(cmd('task.create',{modelProfile:profile,...fields}))}
}

test('a mail-free task pauses for a versioned form and resumes once in the same personal timeline',async t=>{
  let calls=0
  const f=fixture(t,{async *stream({tools,messages}){
    calls++
    assert.ok(!tools.some(tool=>tool.name==='mail_search'))
    if (!messages.some(message=>message.role==='tool')) {
      yield {type:'tool_call',id:'ask',name:'ask_user',arguments:{question:'Which format?',fields:[{id:'format',label:'Format',type:'choice',required:true,options:['PDF','CSV']}]}}
      yield {type:'finish',reason:'tool_calls'}
    } else {
      const answer=JSON.parse(messages.find(message=>message.role==='tool').content)
      assert.deepEqual(answer.answer,{format:'PDF'})
      yield {type:'text_delta',text:'PDF selected.'};yield {type:'finish',reason:'stop'}
    }
  }})
  const task=await f.create({message:'Help me choose an export.'});await f.drain()
  const waiting=f.service.store.getTask(task.taskId)
  assert.equal(waiting.state,'waiting_user');assert.equal(calls,1)
  const response=cmd('interaction.respond',{interactionId:waiting.waitingInteractionId,expectedVersion:1,answer:{format:'PDF'}})
  const accepted=await f.service.command(response)
  assert.deepEqual(await f.service.command(response),accepted)
  await f.drain()
  assert.equal(f.service.store.getTask(task.taskId).state,'completed');assert.equal(calls,2)
  const timeline=f.service.timeline()
  assert.equal(timeline.conversationId,'primary')
  assert.equal(timeline.messages.at(-1).content,'PDF selected.')
  await assert.rejects(f.service.command(cmd('interaction.respond',{interactionId:waiting.waitingInteractionId,expectedVersion:1,answer:{format:'CSV'}})),{code:'stale_version'})
})

test('multi-mailbox reads use explicit authorized targets and commit results in model order',async t=>{
  const readTargets=[]
  const f=fixture(t,{async read(name,input,ctx){readTargets.push(ctx.mailboxId);return {mailbox:ctx.mailboxId}},async *stream({tools,messages}){
    if (messages.some(message=>message.role==='tool')) {
      assert.deepEqual(messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content).mailbox),['b','a'])
      yield {type:'finish',reason:'stop'};return
    }
    const schema=tools.find(tool=>tool.name==='mail_list_organization').inputSchema
    assert.ok(schema.required.includes('mailboxId'))
    assert.deepEqual(schema.properties.mailboxId.enum,['a','b'])
    for(const mailboxId of ['b','a']) yield {type:'tool_call',id:'call-'+mailboxId,name:'mail_list_organization',arguments:{mailboxId}}
    yield {type:'finish',reason:'tool_calls'}
  }})
  const task=await f.create({mailboxIds:['a','b'],message:'Compare folders.'});await f.drain()
  assert.equal(f.service.store.getTask(task.taskId).state,'completed')
  assert.deepEqual(readTargets,['b','a'])
})

test('history requires the complete mailbox and connector scope of the historical task',async t=>{
  const f=fixture(t,{async *stream(){yield {type:'finish',reason:'stop'}}})
  f.service.host.kick=()=>{}
  const a=await f.create({mailboxIds:['a'],message:'Orion project private alpha'})
  const ab=await f.create({mailboxIds:['a','b'],message:'Orion project combined beta'})
  const none=await f.create({message:'Orion project public planning'})
  const call=taskId=>f.service.queryHistory('history_search',{callerTaskId:taskId,query:'Orion'}).result.results.map(hit=>hit.taskId)
  assert.ok(!call(a.taskId).includes(ab.taskId))
  assert.ok(call(ab.taskId).includes(a.taskId))
  assert.deepEqual(call(none.taskId),[])
  const combined=f.service.store.getTask(ab.taskId)
  combined.connectorIds=['other'];combined.connectorEpochs={other:1};f.service.store.saveTask(combined)
  const scope={callerTaskId:a.taskId,allowedMailboxes:['a','b'],allowedConnectors:[]}
  assert.ok(!f.service.memory.history.search({query:'Orion'},scope).results.some(hit=>hit.taskId===ab.taskId))
  const message=f.service.store.messages(ab.taskId)[0]
  assert.throws(()=>f.service.memory.history.read({taskId:ab.taskId,messageId:message.messageId},scope),{code:'history_source_not_found'})
})

test('MCP writes wait for exact approval and resume one parent without replay after rejection or success',async t=>{
  let remoteWrites=0
  const schema={type:'object',additionalProperties:false,required:['query'],properties:{query:{anyOf:[{type:'string',minLength:1},{type:'null'}]}}}
  const env={CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),MCP_SERVERS:{notes:{endpoint:'https://mcp.example.com/mcp',tools:{create:{access:'write',mailWrite:false}}}}}
  const f=fixture(t,{env,fetcher:async (url,init)=>{
    const body=JSON.parse(init.body)
    if (body.method==='tools/call') remoteWrites++
    return Response.json({jsonrpc:'2.0',id:body.id,result:{resultType:'complete',...(body.method==='tools/list' ? {tools:[{name:'create',inputSchema:schema}]} : {content:[{type:'text',text:'created'}]})}})
  },async *stream({tools,messages}){
    if (messages.some(message=>message.role==='tool')) {yield {type:'finish',reason:'stop'};return}
    const tool=tools.find(tool=>tool.name.startsWith('mcp_'))
    yield {type:'tool_call',id:'create',name:tool.name,arguments:{query:'Exact approved note'}}
    yield {type:'finish',reason:'tool_calls'}
  }})
  const connection=await f.service.connectors.put({serverId:'notes',token:'test-token'})
  await f.service.connectors.discover({connectionId:connection.id,expectedEpoch:1})
  const task=await f.create({message:'Create a note.',connectorIds:[connection.id]});await f.drain()
  const pending=f.service.store.getTask(task.taskId)
  assert.equal(pending.state,'waiting_connector');assert.equal(remoteWrites,0)
  const op=f.service.connectors.operation(pending.waitingOperationId)
  const approval=cmd('connector.approve',{operationId:op.operationId,approvalVersion:op.approvalVersion})
  const result=await f.service.command(approval)
  assert.deepEqual(await f.service.command(approval),result)
  await f.drain()
  assert.equal(f.service.store.getTask(task.taskId).state,'completed')
  assert.equal(remoteWrites,1)
  const messages=f.service.store.messages(task.taskId)
  assert.equal(messages.filter(message=>message.role==='tool').length,1)
  assert.equal(JSON.parse(messages.find(message=>message.role==='tool').content).state,'succeeded')
})

test('device analysis sync uses indexed message IDs, detects edit races, and never calls a model',async t=>{
  const f=fixture(t,{async *stream(){assert.fail('on-device analysis must not invoke a model')}})
  const indexEpoch=f.service.index.index.meta('a','gmail').epoch
  const mapped=f.service.index.index.remember('a','gmail',{citation:{mailboxId:'a',messageId:'provider-one'},subject:'Invoice',preview:'Total 12'}, {epoch:indexEpoch,now:Date.now()})
  const body={mailboxId:'a',items:[{messageId:mapped.mailMessageId,expectedVersion:0,providerVersion:'v1',summary:'Amount due 12',categories:['invoice']}]}
  const request=cmd('mail.analysis.sync',body)
  const accepted=await f.service.command(request)
  assert.deepEqual(await f.service.command(request),accepted)
  await f.drain()
  assert.equal(accepted.analyses[0].source,'on_device')
  await assert.rejects(f.service.command(cmd('mail.analysis.sync',body)),{code:'stale_version'})
  f.service.store.rows('INSERT INTO mail_observations VALUES (?,?)',JSON.stringify(['a','message:provider-one']),'v2')
  assert.equal(f.service.clientState.analysis({mailboxId:'a',messageIds:[mapped.mailMessageId]}).analyses[0].status,'stale')
})

test('revoking a device stops its queued tasks and requires a fresh session for new work',async t=>{
  const f=fixture(t,{async *stream(){assert.fail('revoked work must not run')}})
  f.service.host.kick=()=>{}
  const auth=f.service.sessions.accept({sessionId:'device-one',issuedAt:Math.floor(Date.now()/1000)-2,expires:Math.floor(Date.now()/1000)+3600})
  const task=await f.service.command(cmd('task.create',{message:'Wait for work.',modelProfile:profile}),auth)
  const newSession=f.service.sessions.accept({sessionId:'device-two',issuedAt:auth.issuedAt,expires:auth.expires})
  await f.service.command(cmd('session.revoke',{sessionId:auth.sessionId,expectedVersion:1}),newSession)
  assert.equal(f.service.store.getTask(task.taskId).state,'cancelled')
  await assert.rejects(f.service.command(cmd('task.create',{message:'Unauthorized task',modelProfile:profile}),auth),{code:'session_revoked'})
  assert.throws(()=>f.service.sessions.accept(auth),{code:'session_revoked'})
})

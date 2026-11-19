import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { AgentService } from '../src/service.mjs'
import { createStorage } from './support/storage.mjs'

const encode=value=>new TextEncoder().encode(value)
const cmd=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})
const profile={provider:'openai',model:'parent-model',effort:'low',connectionId:'model'}
const listing=data=>({data,has_more:false,last_id:data.at(-1)?.id || null})

class Bucket {
  values=new Map();writes=[]
  async put(key,bytes,options={}){
    this.writes.push(key)
    this.values.set(key,{key,bytes:bytes.slice(),size:bytes.length,customMetadata:options.customMetadata,httpMetadata:options.httpMetadata})
    return this.head(key)
  }
  async head(key){const value=this.values.get(key);if(!value)return null;const {bytes,...meta}=value;return meta}
  async get(key){const value=this.values.get(key);return value?{...await this.head(key),body:new Blob([value.bytes]).stream()}:null}
  async delete(key){this.values.delete(key)}
}

// No real provider, model, MCP or mailbox request is made by these tests.
function provider(){
  const p={calls:[],sessions:new Map(),files:new Map(),artifacts:[],loseCreate:0,loseDelete:0,
    finalText:'Verified child analysis.',confirmCancel:true,hook:null}
  p.fetch=async(url,options={})=>{
    const target=new URL(url),path=target.pathname,method=options.method || 'GET'
    assert.equal(target.origin,'https://api.openai.com')
    assert.equal(options.headers.Authorization,'Bearer operator-fixture-key')
    assert.equal(options.redirect,'manual')
    const body=typeof options.body==='string'?JSON.parse(options.body):options.body
    p.calls.push({path,method,body})
    const override=await p.hook?.({path,method,body})
    if(override)return override
    if(path==='/v1/agents/sessions' && method==='POST'){
      assert.deepEqual(body.agent.tools,[])
      assert.equal(body.environment.network.access,'disabled')
      assert.doesNotMatch(JSON.stringify(body),/parent-user-key|mcp-private-key|mail-private-key/)
      const id='session_'+(p.sessions.size+1)
      const session={id,status:'running',metadata:body.metadata,required_actions:[],environment:{id:'environment_'+id},turnStatus:'completed'}
      p.sessions.set(id,session)
      if(p.loseCreate-->0)throw new TypeError('accepted but response lost')
      return Response.json(session)
    }
    if(path==='/v1/agents/sessions')return Response.json(listing([...p.sessions.values()].filter(s=>!s.deleted)))
    if(path==='/v1/files' && method==='POST'){
      const file=body.get('file'),id='file_'+(p.files.size+1)
      p.files.set(id,{id,filename:file.name,bytes:file.size});return Response.json(p.files.get(id))
    }
    if(path==='/v1/files')return Response.json(listing([...p.files.values()].filter(f=>!f.deleted)))
    const file=/^\/v1\/files\/([^/]+)$/.exec(path)
    if(file){assert.equal(method,'DELETE');p.files.get(file[1]).deleted=true;return new Response(null,{status:204})}
    const match=/^\/v1\/agents\/sessions\/([^/]+)(.*)$/.exec(path)
    assert.ok(match,'unrecognized hosted endpoint '+path)
    const session=p.sessions.get(match[1]),suffix=match[2]
    if(!session || session.deleted)return Response.json({error:{}},{status:404})
    if(!suffix && method==='GET')return Response.json(session)
    if(!suffix && method==='DELETE'){
      session.deleted=true
      if(p.loseDelete-->0)throw new TypeError('deleted but response lost')
      return new Response(null,{status:204})
    }
    if(suffix==='/events'){
      assert.deepEqual(body.events,[{type:'agent.session.input.cancel'}])
      if(p.confirmCancel){session.status='idle';session.turnStatus='cancelled'}
      return new Response(null,{status:202})
    }
    if(suffix==='/turns')return Response.json(listing([{id:'turn_'+session.id,session_id:session.id,
      status:session.turnStatus,usage:{input_tokens:11,output_tokens:7}}]))
    if(/^\/turns\/[^/]+\/items$/.test(suffix))return Response.json(listing([{id:'answer_'+session.id,
      type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:p.finalText}]}]))
    if(suffix==='/artifacts')return Response.json(listing(p.artifacts.map(item=>({id:item.id,
      path:item.path,size_bytes:item.bytes.length,session_id:session.id,turn_id:'turn_'+session.id,environment_id:session.environment.id}))))
    const artifact=/^\/artifacts\/([^/]+)\/content$/.exec(suffix)
    if(artifact)return new Response(p.artifacts.find(item=>item.id===artifact[1]).bytes)
    assert.fail('unrecognized hosted endpoint '+path)
  }
  return p
}

function fixture(t,{secondCall=false}={}){
  const storage=createStorage();t.after(()=>storage.close())
  const bucket=new Bucket(),p=provider(),pending=new Set(),modelInputs=[],responses=[]
  const records={model:{id:'model',kind:'model',provider:'openai',status:'active',epoch:1},
    box:{id:'box',kind:'mail',provider:'gmail',status:'active',epoch:1,actions:['mark_read'],scopes:['https://www.googleapis.com/auth/gmail.modify']}}
  const connections={get:id=>records[id],assertEpoch(id,epoch){
    if(!records[id] || records[id].status!=='active')throw Object.assign(Error(),{code:'connection_revoked',status:403})
    if(records[id].epoch!==epoch)throw Object.assign(Error(),{code:'connection_changed',status:409})
  },async credential(id,epoch){this.assertEpoch(id,epoch);return 'parent-user-key'}}
  const env={ASSETS:bucket,CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,66).toString('base64'),
    HOSTED_AGENT_ENABLED:'true',HOSTED_AGENT_MODEL:'child-model',OPENAI_AGENTS_API_KEY:'operator-fixture-key',
    MCP_SERVERS:{notes:{endpoint:'https://mcp.example.com/mcp',tools:{search:{access:'read',approval:'never',mailWrite:false}}}}}
  let service,time=Date.now(),selectedAssets=[]
  const model={async *stream({messages,tools}){
    modelInputs.push(structuredClone(messages))
    const latest=messages.filter(m=>m.role==='user').at(-1)?.content || ''
    if(latest.includes('ordinary') || latest.includes('replacement')){
      yield {type:'text_delta',text:latest.includes('replacement')?'Replacement completed.':'Ordinary task completed.'}
      yield {type:'finish',reason:'stop'};return
    }
    const results=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content))
    if(results.length){
      responses.push(results)
      yield {type:'text_delta',text:'Parent consumed the current tool receipt.'}
      yield {type:'finish',reason:'stop'};return
    }
    assert.ok(tools.some(tool=>tool.name==='delegate_task'))
    yield {type:'tool_call',id:'delegate-call',name:'delegate_task',arguments:{instructions:'Analyze only the selected data.',input:'Scoped child input.',attachmentIds:selectedAssets}}
    if(secondCall)yield {type:'tool_call',id:'after-delegate',name:'asset_list',arguments:{}}
    yield {type:'finish',reason:'tool_calls'}
  }}
  const ctx={storage,id:{toString:()=> 'hosted-runtime-account'},getWebSockets:()=>[],waitUntil(promise){
    pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise))
  }}
  const open=()=>{
    service=new AgentService(ctx,env,{connections,model,fetcher:p.fetch})
    service.host.kick=()=>{} // Tests control durable wakes, not elapsed wall time.
    service.hosted.now=()=>time;service.assets.clock=()=>time
    return service
  }
  open()
  const f={storage,bucket,p,records,modelInputs,responses,env,
    get service(){return service},reopen:open,
    async upload(){
      const asset=await service.assets.put({name:'source.txt',mimeType:'text/plain',body:encode('Selected document.')})
      selectedAssets=[asset.id];return asset
    },
    async create(fields={}){
      const command=cmd('task.create',{message:'Analyze this complex document.',modelProfile:profile,allowHosted:true,assetIds:selectedAssets,...fields})
      const accepted=await service.command(command)
      return {...accepted,command}
    },
    async flush(){
      for(let i=0;i<50;i++){
        await tick();if(!pending.size)return
        const results=await Promise.allSettled([...pending])
        for(const result of results)if(result.status==='rejected')throw result.reason
      }
      assert.fail('local background promises failed to settle')
    },
    async dispatch(){await service.host.dispatch();await f.flush()},
    async runTask(id){
      const task=service.store.getTask(id)
      assert.equal(task.state,'queued')
      task.state='running';service.store.saveTask(task)
      await service.harness.run(task,new AbortController().signal)
      return service.store.getTask(id)
    },
    async childStep(){
      const due=service.hosted.nextDue();if(due===null)return false
      time=Math.max(time,due);return service.hosted.runNext()
    },
    async until(predicate,max=100){
      for(let i=0;i<max;i++){if(predicate())return;assert.equal(await f.childStep(),true)}
      assert.fail('hosted state did not reach expected condition')
    },
    async cleanup(){await f.until(()=>service.hosted.nextDue()===null)},
    child(taskId){return service.hosted.list({parentTaskId:taskId}).executions[0]},
    complete(){for(const session of p.sessions.values())if(!session.deleted){session.status='idle';session.turnStatus='completed'}},
  }
  return f
}

test('a delegated parent releases foreground capacity while another task completes in the same timeline',async t=>{
  const f=fixture(t),parent=await f.create()
  await f.dispatch()
  assert.equal(f.service.store.getTask(parent.taskId).state,'waiting_external')
  assert.equal(f.service.host.tasks.size,0)
  assert.equal(f.service.store.messages(parent.taskId).filter(m=>m.role==='tool').length,0)
  await f.childStep()
  const ordinary=await f.create({message:'ordinary independent work',allowHosted:false})
  await f.dispatch()
  assert.equal(f.service.store.getTask(ordinary.taskId).state,'completed')
  assert.equal(f.service.store.getTask(parent.taskId).state,'waiting_external')
  f.complete();await f.until(()=>f.child(parent.taskId).delivered)
  assert.equal(f.service.store.getTask(parent.taskId).state,'queued')
  await f.runTask(parent.taskId);await f.cleanup()
  assert.equal(f.service.store.getTask(parent.taskId).state,'completed')
  assert.equal(f.responses[0][0].result.text,f.p.finalText)
  assert.equal(f.p.calls.filter(call=>call.method==='POST' && call.path==='/v1/agents/sessions').length,1)
  assert.deepEqual(new Set(f.service.timeline().messages.map(m=>m.taskId)),new Set([parent.taskId,ordinary.taskId]))
})

test('undelivered terminal artifacts do not enter parent context; a rebuilt service publishes exactly one result after receipt commit',async t=>{
  const f=fixture(t)
  f.p.artifacts=[{id:'artifact_one',path:'/workspace/outputs/analysis.txt',bytes:encode('Generated report.') }]
  const parent=await f.create();await f.runTask(parent.taskId);await f.childStep();f.complete()
  const complete=f.service.hosted.onComplete
  let failed=false
  f.service.hosted.onComplete=job=>{complete(job);if(!failed){failed=true;throw Error('delivery transaction interrupted')}}
  await f.until(()=>failed)
  const child=f.child(parent.taskId)
  assert.equal(child.state,'completed');assert.equal(child.delivered,false);assert.equal(child.result,undefined)
  assert.equal(f.service.store.getTask(parent.taskId).state,'waiting_external')
  assert.deepEqual(f.service.store.getTask(parent.taskId).assetIds,[])
  const imported=f.service.assets.list().assets
  assert.equal(imported.length,1)
  // A repair requeue must still respect the hosted delivery barrier.
  const repair=f.service.store.getTask(parent.taskId);repair.state='queued';f.service.store.saveTask(repair)
  await f.runTask(parent.taskId)
  assert.equal(f.service.store.getTask(parent.taskId).state,'waiting_external')
  assert.equal(f.responses.length,0)
  f.reopen();await f.until(()=>f.child(parent.taskId).delivered)
  await f.runTask(parent.taskId);await f.cleanup()
  assert.deepEqual(f.service.store.getTask(parent.taskId).assetIds,[imported[0].id])
  assert.equal(f.responses.length,1);assert.equal(f.responses[0][0].result.artifacts[0].id,imported[0].id)
  assert.equal(f.bucket.writes.length,1)
  f.reopen();assert.equal(await f.service.hosted.runNext(),false)
  assert.equal(f.service.store.messages(parent.taskId).filter(m=>m.role==='tool').length,1)
})

test('parent cancellation and steering fence late hosted success and cannot revive an older run',async t=>{
  for(const action of ['task.cancel','task.steer'])await t.test(action,async t=>{
    const f=fixture(t),parent=await f.create();await f.runTask(parent.taskId);await f.childStep()
    const oldRun=f.service.store.getTask(parent.taskId).runId
    await f.service.command(cmd(action,{taskId:parent.taskId,taskVersion:1,...(action==='task.steer'?{message:'replacement task'}:{})}))
    if(action==='task.steer')await f.runTask(parent.taskId)
    f.complete();await f.cleanup()
    const current=f.service.store.getTask(parent.taskId)
    assert.equal(current.state,action==='task.cancel'?'cancelled':'completed')
    assert.equal(current.version,2)
    if(action==='task.steer')assert.notEqual(current.runId,oldRun)
    assert.equal(f.child(parent.taskId).result,undefined)
    assert.equal(f.child(parent.taskId).state,'cancelled')
    assert.doesNotMatch(JSON.stringify(f.service.store.messages(parent.taskId)),/Verified child analysis/)
    assert.equal(f.p.calls.filter(call=>call.method==='POST' && call.path==='/v1/agents/sessions').length,1)
    assert.equal(f.responses.length,0)
  })
})

test('memory deletion and configuration changes close hosted waits and resume with current privacy settings',async t=>{
  for(const action of ['memory.delete','memory.configure'])await t.test(action,async t=>{
    const f=fixture(t,{secondCall:true})
    await f.service.command(cmd('memory.upsert',{key:'profile.private_note',kind:'fact',value:'PRIVATE_REMEMBERED_FACT'}))
    const parent=await f.create();await f.runTask(parent.taskId);await f.childStep()
    const waiting=f.service.store.getTask(parent.taskId)
    assert.equal(waiting.state,'waiting_external')
    await f.service.command(cmd(action,action==='memory.delete'?{key:'profile.private_note',expectedVersion:1}:{enabled:false,expectedVersion:1}))
    assert.equal(f.service.store.getTask(parent.taskId).state,'queued')
    assert.equal(f.child(parent.taskId).state,'cancel_requested')
    await f.runTask(parent.taskId)
    assert.equal(f.service.store.getTask(parent.taskId).state,'completed')
    assert.equal(f.responses.length,1)
    assert.equal(f.responses[0][0].error,'memory_context_changed')
    assert.equal(f.responses[0][0].state,'cancel_requested')
    assert.equal(f.responses[0].length,2)
    assert.doesNotMatch(f.modelInputs.at(-1).filter(m=>m.role==='system').map(m=>m.content).join('\n'),/PRIVATE_REMEMBERED_FACT/)
    f.complete();await f.cleanup()
    assert.equal(f.service.store.getTask(parent.taskId).state,'completed')
    assert.equal(f.child(parent.taskId).result,undefined)
    assert.equal(f.responses.length,1)
  })
})

test('cancelling only the delegated execution waits for remote confirmation before resuming the parent with a cancelled receipt',async t=>{
  const f=fixture(t),parent=await f.create();await f.runTask(parent.taskId);await f.childStep()
  f.p.confirmCancel=false
  const id=f.child(parent.taskId).executionId
  await f.service.command(cmd('execution.cancel',{executionId:id}))
  await f.childStep()
  assert.equal(f.child(parent.taskId).state,'cancel_requested')
  assert.equal(f.service.store.getTask(parent.taskId).state,'waiting_external')
  assert.equal(f.responses.length,0)
  f.complete();await f.until(()=>f.child(parent.taskId).delivered)
  assert.equal(f.service.store.getTask(parent.taskId).state,'queued')
  await f.runTask(parent.taskId);await f.cleanup()
  assert.equal(f.responses[0][0].state,'cancelled')
  assert.equal(f.responses[0][0].result,undefined)
  assert.equal(f.service.store.getTask(parent.taskId).state,'completed')
})

test('revoking the authorizing local session cancels its waiting parent and ignores the later hosted completion',async t=>{
  const f=fixture(t)
  const auth=f.service.sessions.accept({sessionId:'device-one',issuedAt:Math.floor(Date.now()/1000)-1,expires:Math.floor(Date.now()/1000)+3600})
  const parent=await f.service.command(cmd('task.create',{message:'Analyze this complex document.',modelProfile:profile,allowHosted:true}),auth)
  await f.runTask(parent.taskId);await f.childStep()
  f.service.sessions.revoke({sessionId:auth.sessionId,expectedVersion:1})
  assert.equal(f.service.store.getTask(parent.taskId).state,'cancelled')
  f.complete();await f.cleanup()
  assert.equal(f.service.store.getTask(parent.taskId).state,'cancelled')
  assert.equal(f.responses.length,0)
  assert.equal(f.child(parent.taskId).result,undefined)
})

test('resource revocation during a hosted wait closes the matching parent without another model call',async t=>{
  for(const kind of ['model','mail','connector','asset'])await t.test(kind,async t=>{
    const f=fixture(t,{secondCall:true}),extra={}
    let resource
    if(kind==='mail')extra.mailboxIds=['box']
    if(kind==='connector'){
      resource=await f.service.connectors.put({serverId:'notes',token:'mcp-private-key'})
      extra.connectorIds=[resource.id]
    }
    if(kind==='asset')resource=await f.upload()
    const parent=await f.create(extra);await f.runTask(parent.taskId)
    await f.until(()=>f.child(parent.taskId).state==='running')
    if(kind==='model'||kind==='mail'){
      const connection=f.records[kind==='model'?'model':'box'];connection.epoch++;connection.status='revoked'
    }else if(kind==='connector')f.service.connectors.revoke(resource.id,resource.epoch)
    else await f.service.command(cmd('asset.delete',{assetId:resource.id}))
    await f.cleanup()
    const current=f.service.store.getTask(parent.taskId)
    assert.equal(current.state,'failed','revoked '+kind+' must not leave a permanent hosted wait')
    assert.equal(current.pending,null)
    assert.equal(f.modelInputs.length,1)
    assert.equal(f.child(parent.taskId).result,undefined)
    assert.doesNotMatch(JSON.stringify(f.service.store.messages(parent.taskId)),/Verified child analysis/)
    assert.equal(f.service.store.messages(parent.taskId).filter(m=>m.role==='tool').length,2)
  })
})

test('lost session creation and deletion acknowledgements recover across AgentService reconstruction without a second delegation',async t=>{
  const f=fixture(t);f.p.loseCreate=1;f.p.loseDelete=1
  const parent=await f.create();await f.runTask(parent.taskId);await f.childStep()
  const id=f.child(parent.taskId).executionId
  assert.equal(f.child(parent.taskId).state,'submitting')
  f.reopen();f.complete()
  await f.until(()=>f.child(parent.taskId).delivered)
  assert.equal(f.child(parent.taskId).executionId,id)
  await f.runTask(parent.taskId)
  await f.until(()=>[...f.p.sessions.values()].some(s=>s.deleted))
  assert.notEqual(f.service.hosted.nextDue(),null)
  f.reopen();await f.cleanup()
  assert.equal(f.child(parent.taskId).cleanup,'completed')
  assert.deepEqual(await f.service.command(parent.command),Object.fromEntries(Object.entries(parent).filter(([key])=>key!=='command')))
  assert.equal(f.p.calls.filter(call=>call.method==='POST' && call.path==='/v1/agents/sessions').length,1)
  assert.equal(f.p.calls.filter(call=>call.method==='DELETE' && call.path.includes('/sessions/')).length,2)
  assert.equal(f.responses.length,1)
  assert.equal(f.service.store.messages(parent.taskId).filter(m=>m.role==='tool').length,1)
})

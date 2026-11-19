import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from './support/storage.mjs'
import { Store } from '../src/store.mjs'
import { AccountLifecycleService } from '../src/account/index.mjs'
import { MemoryService } from '../src/memory/index.mjs'
import { ConnectionStore } from '../src/connections/index.mjs'
import { ConnectorService } from '../src/connectors/index.mjs'
import { AssetService } from '../src/assets/index.mjs'
import { HostedExecutionService } from '../src/executors/index.mjs'
import { SessionService } from '../src/sessions.mjs'
import { MailIndexService } from '../src/mail-index/index.mjs'
import { ClientStateService } from '../src/client-state.mjs'
import { InteractionService } from '../src/interactions.mjs'
import { ScheduleService } from '../src/schedules.mjs'
import { UsageService } from '../src/usage.mjs'

const encoder=new TextEncoder()
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
class Bucket {
  values=new Map();deletes=[];putHook=null;deleteHook=null
  async put(key,bytes,options){
    const entry={key,size:bytes.length,bytes:bytes.slice(),customMetadata:options.customMetadata,httpMetadata:options.httpMetadata}
    this.values.set(key,entry)
    if(this.putHook)await this.putHook()
    return this.head(key)
  }
  async head(key){const entry=this.values.get(key);if(!entry)return null;const {bytes,...meta}=entry;return meta}
  async get(key){const entry=this.values.get(key);return entry?{...await this.head(key),body:new Blob([entry.bytes]).stream()}:null}
  async delete(key){this.deletes.push(key);this.values.delete(key);if(this.deleteHook)await this.deleteHook()}
}
function fixture(t,options={}){
  const storage=createStorage();t.after(()=>storage.close())
  let time=1_000_000,active=0,lifecycle
  const now=()=>time,store=new Store(storage),bucket=options.bucket || new Bucket()
  const env={ASSETS:bucket,CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,88).toString('base64'),
    MCP_SERVERS:{notes:{endpoint:'https://mcp.example.com/mcp',tools:{create:{access:'write',mailWrite:false}}}},...options.env}
  const connections=new ConnectionStore(storage,env,{transaction:fn=>store.tx(fn)})
  const memory=new MemoryService(store,{connections,now})
  const connectors=new ConnectorService(store,env,{now,fetcher:async()=>{throw Error('no external MCP calls')}})
  const assets=new AssetService(store,env,{ownerId:'test-account',clock:now,assertCurrent:()=>lifecycle?.assertActive()})
  const sessions=new SessionService(store)
  const index=new MailIndexService(store,{now})
  const clientState=new ClientStateService(store,{mail:{metadata:()=>({epoch:1})},index})
  new InteractionService(store)
  store.rows('CREATE TABLE IF NOT EXISTS task_context_checkpoints (taskId TEXT PRIMARY KEY,data TEXT NOT NULL)')
  store.rows('CREATE TABLE IF NOT EXISTS task_context_attempts (taskId TEXT PRIMARY KEY,data TEXT NOT NULL)')
  const executors=options.executors || new HostedExecutionService(store,env,{assets,now,fetcher:options.fetcher || (async()=>{throw Error('no hosted calls')})})
  const make=()=>new AccountLifecycleService(store,{assets,connections,connectors,executors,memory,sessions,now,
    activeCount:()=>active,onFence:options.onFence || (()=>{}),participants:options.participants || [],cleanupTimeoutMS:options.cleanupTimeoutMS || 900000})
  lifecycle=make()
  return {storage,store,env,bucket,assets,connections,connectors,memory,sessions,index,clientState,executors,
    get lifecycle(){return lifecycle},get now(){return time},setActive:value=>{active=value},advance:ms=>{time+=ms},
    reopen:()=>{lifecycle=make();lifecycle.recover();return lifecycle}}
}
function seed(f,{id='task',content='A private conversation.'}={}){
  const task={id,runId:'run-'+id,version:1,state:'waiting_mail',waitingOperationId:'mail-'+id,
    profile:{provider:'openai',model:'test',effort:'low',connectionId:'model'},mailboxId:'box',createdAt:1}
  f.store.saveTask(task,false)
  const message=f.store.appendMessage(task,{role:'user',content,providerState:{cipher:'PRIVATE_REASONING'}})
  f.memory.observe(id,message.messageId)
  return task
}
function mailOp(f,{id='mail-task',state='queued',payload='PRIVATE_FROZEN_MAIL',resource='message:m1'}={}){
  const op={id,state,version:1,mailboxId:'box',epoch:1,taskId:'task',commandId:'command-'+id,
    resourceKey:JSON.stringify(['box',resource]),prepared:{action:'modify_message',resource,summary:{subject:'PRIVATE_PREVIEW'},payload:{body:payload}}}
  f.store.saveOp(op)
  return op
}
async function step(f){
  const due=f.lifecycle.nextDue()
  if(due===null)return false
  f.advance(Math.max(0,due-f.now))
  return f.lifecycle.runNext()
}
async function finish(f,max=180){
  for(let i=0;i<max;i++){
    if(['active','deleted','blocked'].includes(f.lifecycle.status().state))return f.lifecycle.status()
    assert.equal(await step(f),true)
  }
  assert.fail('lifecycle did not reach an observable stop: '+JSON.stringify(f.lifecycle.status()))
}

test('generation and memory epoch commit before cancellation; no in-flight mail row is erased before the local barrier',async t=>{
  let observed,f
  f=fixture(t,{onFence:()=>{observed={generation:f.lifecycle.generation(),epoch:f.memory.state().epoch};assert.throws(()=>f.lifecycle.assertActive(),{code:'account_lifecycle_in_progress'})}})
  seed(f);mailOp(f);mailOp(f,{id:'dispatched',state:'dispatching'})
  f.setActive(1)
  const started=f.lifecycle.reset({requestId:'reset-one',expectedGeneration:1})
  assert.equal(started.generation,2);assert.deepEqual(observed,{generation:2,epoch:2})
  assert.equal(f.store.getTask('task').state,'cancelled')
  assert.equal(f.store.getOp('mail-task').state,'cancelled')
  assert.equal(f.store.getOp('dispatched').state,'dispatching')
  await step(f)
  assert.ok(f.store.one('SELECT 1 FROM messages'))
  // A locally in-flight provider call can still settle before the drain barrier.
  const late=f.store.getOp('dispatched');late.state='succeeded';late.receipt={status:'succeeded'};f.store.saveOp(late)
  f.setActive(0)
  assert.equal((await finish(f)).state,'active')
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM tasks').n,0)
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM operations').n,0)
  assert.equal(f.lifecycle.status().uncertainOperations,0)
  assert.throws(()=>f.lifecycle.assertActive(1),{code:'account_generation_changed'})
})

test('chat reset preserves approved facts, connections and mailbox previews, removes task material and retains replay tombstones',async t=>{
  const f=fixture(t);seed(f)
  f.memory.upsert({key:'reply.language',kind:'preference',value:'Chinese'})
  f.memory.write({key:'account.role',kind:'fact',value:'Engineer',source:{type:'user_statement',messageId:'old-message',evidence:'PRIVATE_EVIDENCE'}})
  const key=await f.connections.putModel({provider:'openai',apiKey:'private-model-key'})
  const connector=await f.connectors.put({serverId:'notes',token:'private-mcp-key'})
  f.index.index.remember('box','gmail',{citation:{messageId:'m1'},subject:'Preview',from:'a@example.com',preview:'Kept mailbox snippet',date:'2026-01-01T00:00:00Z'})
  f.clientState.workItem({id:'work',title:'Private work title'})
  f.store.rows('INSERT INTO task_context_checkpoints VALUES (?,?)','task',JSON.stringify({secret:'PRIVATE_CHECKPOINT'}))
  f.store.command('old-command','digest-only',()=>({text:'PRIVATE_COMMAND_RESULT'}))
  const asset=await f.assets.put({name:'private-note.txt',mimeType:'text/plain',body:encoder.encode('PRIVATE_DOCUMENT'),idempotencyKey:'asset-retry'})
  f.lifecycle.reset({requestId:'reset-preserve'})
  assert.equal((await finish(f)).state,'active')
  assert.equal(f.memory.get('reply.language').value,'Chinese')
  assert.deepEqual(f.memory.get('account.role').source,{type:'user_statement',retainedAfterReset:true})
  assert.equal(f.connections.get(key.id).status,'active')
  assert.equal(f.connectors.get(connector.id).status,'active')
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM mail_index').n,1)
  for(const table of ['tasks','messages','memory_history','memory_jobs','work_items','task_context_checkpoints'])assert.equal(f.store.one('SELECT COUNT(*) AS n FROM '+table).n,0)
  assert.equal(f.bucket.values.size,0)
  assert.throws(()=>f.assets.get(asset.id),{status:410})
  await assert.rejects(f.assets.put({name:'private-note.txt',mimeType:'text/plain',body:encoder.encode('PRIVATE_DOCUMENT'),idempotencyKey:'asset-retry'}),{code:'asset_deleted'})
  assert.equal(f.store.seen('old-command','digest-only').retired,true)
  const privateDump=JSON.stringify(f.store.rows('SELECT data FROM maco_assets'))
  assert.doesNotMatch(privateDump,/private-note|PRIVATE_DOCUMENT|PRIVATE_EVIDENCE/)
  seed(f,{id:'new-task',content:'Fresh searchable conversation'})
  assert.equal(f.memory.searchHistory('searchable').results.length,1)
})

test('resetMemories is explicit; request IDs survive resets and changed intent conflicts',async t=>{
  const f=fixture(t);seed(f)
  f.memory.upsert({key:'profile.role',kind:'fact',value:'Designer'})
  const first=f.lifecycle.reset({requestId:'wipe-memory',resetMemories:true})
  assert.equal(f.lifecycle.reset({requestId:'wipe-memory',resetMemories:true}).operation.operationId,first.operation.operationId)
  assert.throws(()=>f.lifecycle.reset({requestId:'wipe-memory'}),{code:'lifecycle_request_conflict'})
  await finish(f)
  assert.equal(f.memory.get('profile.role'),null)
  const repeat=f.lifecycle.reset({requestId:'wipe-memory',resetMemories:true})
  assert.equal(repeat.request.state,'completed');assert.equal(f.lifecycle.generation(),2)
  assert.throws(()=>f.lifecycle.reset({requestId:'stale',expectedGeneration:1}),{code:'account_generation_changed'})
})

test('reset fences proactive schedules and clears their authorization/material and usage history',async t=>{
  const f=fixture(t);seed(f)
  const schedules=new ScheduleService(f.store,{now:()=>f.now,harness:{bind:profile=>({profile,modelEpoch:77,mailboxIds:[],connectorIds:[]})}})
  schedules.upsert({id:'daily',name:'Daily inbox review',message:'Review visible mail',modelProfile:{provider:'openai',model:'test',effort:'low',connectionId:'model'},nextAt:f.now+60000},'PRIVATE_AUTHORIZATION_SESSION')
  f.store.rows('INSERT INTO schedule_daily_budget VALUES (?,?)',0,3)
  const usage=new UsageService(f.store)
  usage.record('attempt.finished',{taskId:'task',messageId:'usage-one',usage:{inputTokens:12,outputTokens:3}})
  const records=f.lifecycle.export({limit:100}).records
  assert.ok(records.some(record=>record.type==='schedule'))
  assert.ok(records.some(record=>record.type==='model_usage'))
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_AUTHORIZATION_SESSION|modelEpoch/)
  f.lifecycle.reset({requestId:'reset-schedules'})
  assert.equal(schedules.nextDue(),null)
  await finish(f)
  for(const table of ['task_schedules','schedule_daily_budget','model_usage'])assert.equal(f.store.one('SELECT COUNT(*) AS n FROM '+table).n,0)
})

test('reset keeps content-free ambiguous operation locks and never reports them as cancelled sends',async t=>{
  const f=fixture(t);seed(f);mailOp(f,{state:'dispatching'})
  const c=await f.connectors.put({serverId:'notes',token:'secret'})
  f.connectors.saveOperation({id:'mcp-op',connectionId:c.id,taskId:'task',runId:'run-task',tool:'create',
    state:'dispatching',version:1,epoch:1,arguments:{text:'PRIVATE_MCP_ARGUMENT'},receipt:{result:'PRIVATE_MCP_RESULT'}})
  f.lifecycle.reset({requestId:'reset-uncertain'})
  const status=await finish(f)
  assert.equal(status.state,'active');assert.equal(status.uncertainOperations,2)
  const op=f.store.getOp('mail-task')
  assert.equal(op.state,'unknown');assert.equal(op.taskId,null);assert.equal(op.prepared.payload,undefined)
  assert.equal(f.connectors.rawOperation('mcp-op').state,'unknown')
  assert.deepEqual(f.connectors.rawOperation('mcp-op').arguments,{})
  assert.doesNotMatch(JSON.stringify([f.store.rows('SELECT data FROM operations'),f.store.rows('SELECT data FROM connector_operations'),f.lifecycle.status()]),/PRIVATE_/)
})

test('account deletion revokes local credentials/sessions and removes data without deleting a provider mailbox or login identity',async t=>{
  const f=fixture(t);seed(f);mailOp(f,{state:'unknown'})
  await f.connections.putModel({provider:'anthropic',apiKey:'private-key'})
  await f.connectors.put({serverId:'notes',token:'private-token'})
  const issuedAt=Math.floor(Date.now()/1000)-10
  f.sessions.accept({sessionId:'device-session',issuedAt,expires:issuedAt+300})
  const vault=f.store.one('SELECT binding FROM vault_identity').binding
  f.lifecycle.delete({requestId:'delete-account'})
  assert.equal(f.connections.list()[0].status,'revoked')
  assert.equal(f.connectors.list()[0].status,'revoked')
  assert.equal(f.sessions.list().sessions[0].state,'revoked')
  const done=await finish(f)
  assert.equal(done.state,'deleted');assert.equal(done.uncertainOperations,1)
  assert.equal(f.connections.list().length,0);assert.equal(f.connectors.list().length,0)
  assert.equal(f.store.one('SELECT binding FROM vault_identity').binding,vault)
  assert.ok(f.store.one('SELECT revoked_before FROM session_policy').revoked_before)
  assert.throws(()=>f.lifecycle.assertActive(),{code:'account_deleted'})
  assert.throws(()=>f.sessions.accept({sessionId:'device-session',issuedAt,expires:issuedAt+300}),{code:'session_revoked'})
  assert.throws(()=>f.lifecycle.reset({requestId:'resurrect'}),{code:'account_deleted'})
  assert.equal(f.lifecycle.delete({requestId:'delete-account'}).request.state,'completed')
})

test('a fence failure leaves a durable blocked account and reconstruction resumes without another generation',async t=>{
  let fail=true,observed=0
  const f=fixture(t,{onFence:()=>{observed++;if(fail)throw Error('a private internal message')}});seed(f)
  const response=f.lifecycle.reset({requestId:'interrupt-fence'})
  assert.equal(response.state,'resetting');assert.equal(response.operation.phase,'fence')
  assert.throws(()=>f.lifecycle.assertActive(),{code:'account_lifecycle_in_progress'})
  fail=false;f.reopen()
  assert.equal((await finish(f)).state,'active');assert.equal(f.lifecycle.generation(),2)
  assert.ok(observed>=2)
  assert.doesNotMatch(JSON.stringify(f.lifecycle.status()),/private internal/)
})

test('unknown hosted cleanup blocks final completion after independent R2 cleanup, and explicit retry resumes it',async t=>{
  let unknown=true,cancelled=0,redacted=0,erased=0,calls=0
  const executors={cancelAll(){cancelled++},redactAll(){redacted++},recover(){},retryCleanup(){},
    nextDue:()=>unknown?0:null,cleanupStatus:()=>({pending:unknown?1:0,unknown:unknown?1:0,active:0,complete:!unknown}),
    async runNext(){calls++},erase(){assert.equal(unknown,false);erased++}}
  const f=fixture(t,{executors});seed(f)
  await f.assets.put({name:'source.txt',mimeType:'text/plain',body:encoder.encode('retained nowhere')})
  f.lifecycle.delete({requestId:'delete-unknown'})
  const blocked=await finish(f)
  assert.equal(blocked.state,'blocked');assert.equal(blocked.operation.blockedReason,'hosted_outcome_unknown')
  assert.equal(cancelled,1);assert.equal(redacted,1);assert.equal(erased,0);assert.ok(calls>0)
  assert.equal(f.bucket.values.size,0);assert.equal(f.store.one('SELECT COUNT(*) AS n FROM messages').n,0)
  assert.equal(f.lifecycle.nextDue(),null)
  unknown=false
  f.lifecycle.retry({operationId:blocked.operation.operationId})
  assert.equal((await finish(f)).state,'deleted');assert.equal(erased,1)
})

test('R2 deletion acknowledgement loss is retried after reconstruction and never marks cleanup complete early',async t=>{
  const f=fixture(t);seed(f)
  const asset=await f.assets.put({name:'once.txt',mimeType:'text/plain',body:encoder.encode('object')})
  let lost=1
  f.bucket.deleteHook=async()=>{if(lost-->0)throw Error('lost R2 deletion response')}
  f.lifecycle.reset({requestId:'reset-r2'})
  while(!f.bucket.deletes.length)await step(f)
  assert.notEqual(f.lifecycle.status().state,'active')
  assert.equal(f.assets.cleanupStatus().pending,1)
  f.reopen()
  assert.equal((await finish(f)).state,'active')
  assert.equal(f.assets.cleanupStatus().complete,true)
  assert.equal(f.bucket.deletes.length,2)
  assert.throws(()=>f.assets.get(asset.id),{status:410})
})

test('a late R2 upload is drained and removed, never resurrected after reset',async t=>{
  const f=fixture(t),started=deferred(),release=deferred();seed(f)
  f.bucket.putHook=async()=>{started.resolve();await release.promise}
  const uploading=f.assets.put({name:'late.txt',mimeType:'text/plain',body:encoder.encode('late private bytes')})
  const rejected=assert.rejects(uploading)
  await started.promise
  f.lifecycle.reset({requestId:'reset-upload'})
  await step(f);assert.equal(f.lifecycle.status().operation.phase,'drain')
  assert.ok(f.store.one('SELECT 1 FROM messages'))
  release.resolve();await rejected
  assert.equal((await finish(f)).state,'active')
  assert.equal(f.bucket.values.size,0)
  assert.equal(f.assets.list().assets.length,0)
})

test('participant cleanup is durable, retries an explicit unknown and preserves deletion tombstones',async t=>{
  let unknown=true,fences=0,cleanups=0
  const participant={name:'notifications',fence:()=>{fences++},activeCount:()=>0,
    cleanup:async()=>{cleanups++;return {complete:!unknown,unknown}}}
  const f=fixture(t,{participants:[participant]});seed(f)
  f.lifecycle.delete({requestId:'delete-notifications'})
  const blocked=await finish(f)
  assert.equal(blocked.operation.blockedReason,'notifications_cleanup_unknown')
  assert.equal(fences,1);assert.equal(cleanups,1)
  f.reopen();assert.equal(f.lifecycle.status().state,'blocked')
  unknown=false;f.lifecycle.retry({operationId:blocked.operation.operationId})
  assert.equal((await finish(f)).state,'deleted');assert.equal(cleanups,2)
})

test('export is bounded, generation-scoped and excludes vaults, hidden provider state and tool payloads',async t=>{
  const f=fixture(t);seed(f,{content:'Long private chat '.repeat(1000)});mailOp(f)
  await f.connections.putModel({provider:'openai',apiKey:'SECRET_API_KEY_DO_NOT_EXPORT'})
  await f.connectors.put({serverId:'notes',token:'SECRET_MCP_TOKEN_DO_NOT_EXPORT'})
  f.store.rows('INSERT INTO task_context_checkpoints VALUES (?,?)','task',JSON.stringify({summary:'SECRET_CHECKPOINT'}))
  f.store.appendMessage(f.store.getTask('task'),{role:'tool',content:JSON.stringify({accessToken:'SECRET_TOOL_TOKEN'})})
  const first=f.lifecycle.export({limit:1})
  assert.equal(first.format,'maco-account-v1');assert.equal(first.records.length,1);assert.ok(first.nextCursor)
  seed(f,{id:'after-export',content:'NEW_HIGH_WATER_RECORD'})
  const pages=[first]
  while(pages.at(-1).nextCursor){pages.push(f.lifecycle.export({cursor:pages.at(-1).nextCursor,limit:2}));assert.ok(pages.length<30)}
  const serialized=JSON.stringify(pages)
  assert.doesNotMatch(serialized,/SECRET_|PRIVATE_REASONING|PRIVATE_FROZEN_MAIL|NEW_HIGH_WATER_RECORD|sealed|refreshToken/)
  assert.ok(pages.some(page=>page.coverage.truncatedRecords>0))
  for(const page of pages)assert.ok(encoder.encode(JSON.stringify(page)).length<128*1024)
  assert.ok(pages.flatMap(page=>page.records).some(record=>record.type==='connection'))
  f.lifecycle.reset({requestId:'export-invalidated'})
  await finish(f)
  assert.throws(()=>f.lifecycle.export({cursor:first.nextCursor}),{code:'account_export_generation_changed'})
  assert.throws(()=>f.lifecycle.export({cursor:'not base64'}),{code:'invalid_account_export_cursor'})
})

test('a real hosted adapter is cancelled, reconciled and deleted during account lifecycle without normal scheduler maintenance',async t=>{
  const calls=[],remote=new Map()
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname,method=options.method || 'GET';calls.push({path,method})
    if(path==='/v1/agents/sessions' && method==='POST'){
      const body=JSON.parse(options.body),session={id:'session_one',status:'running',metadata:body.metadata,required_actions:[]}
      remote.set(session.id,session);return Response.json(session)
    }
    const session=remote.get('session_one')
    if(path.endsWith('/events')){session.status='idle';return new Response(null,{status:202})}
    if(path.endsWith('/turns'))return Response.json({data:[{id:'turn_one',session_id:'session_one',status:'cancelled',usage:{input_tokens:5,output_tokens:2}}],has_more:false})
    if(method==='DELETE'){remote.clear();return new Response(null,{status:204})}
    if(path.endsWith('/session_one'))return session?Response.json(session):Response.json({error:{}},{status:404})
    assert.fail('unexpected provider call '+path)
  }
  const f=fixture(t,{fetcher,env:{HOSTED_AGENT_ENABLED:'true',OPENAI_AGENTS_API_KEY:'fixture-key',HOSTED_AGENT_MODEL:'configured'}})
  const usage=new UsageService(f.store)
  f.store.onEvent=(type,fields)=>usage.record(type,fields)
  seed(f)
  const job=f.executors.start({parentTaskId:'task',runId:'run-task',runVersion:1,instructions:'Only analyze this text',input:'PRIVATE_HOSTED_TEXT'})
  await f.executors.runNext()
  assert.equal(remote.size,1)
  f.lifecycle.delete({requestId:'delete-with-hosted'})
  assert.equal((await finish(f)).state,'deleted')
  assert.equal(remote.size,0)
  assert.equal(calls.filter(call=>call.method==='POST' && call.path.endsWith('/sessions')).length,1)
  assert.ok(calls.some(call=>call.path.endsWith('/events')))
  assert.ok(calls.some(call=>call.method==='DELETE'))
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM delegations').n,0)
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM model_usage').n,0)
  assert.throws(()=>f.executors.inspect(job.executionId),{code:'execution_not_found'})
})

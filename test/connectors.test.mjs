import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from './support/storage.mjs'
import { Store } from '../src/store.mjs'
import { ConnectorService } from '../src/connectors/index.mjs'
import { inspectSchema, validateArguments } from '../src/connectors/schema.mjs'

const endpoint='https://mcp.example.com/mcp'
const issuer='https://auth.example.com'
const schema={type:'object',properties:{query:{type:'string',minLength:1,maxLength:100}},required:['query'],additionalProperties:false}
const readPolicy={access:'read',approval:'never',mailWrite:false}
const writePolicy={access:'write',mailWrite:false}
function config(overrides={}) {
  return {CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,77).toString('base64'),MCP_OAUTH_REDIRECT_URI:'https://app.example.com/mcp/callback',
    MCP_SERVERS:{notes:{endpoint,tools:{search:readPolicy,create:writePolicy,review:{access:'read',mailWrite:false}},...overrides}}}
}
function fixture(t,{env=config(),fetcher,options={}}={}) {
  const storage=createStorage();t.after(()=>storage.close())
  const events=[],store=new Store(storage,event=>events.push(event))
  const service=new ConnectorService(store,env,{fetcher,...options})
  return {storage,store,events,service,env}
}
function catalog(extra=[]) { return [
  {name:'search',description:'Search notes',inputSchema:schema},
  {name:'create',description:'Create a note',inputSchema:schema,annotations:{readOnlyHint:true}},
  {name:'review',inputSchema:schema},...extra] }
function mcpServer({tools=()=>catalog(),call=()=>({content:[{type:'text',text:'ok'}]}),legacy=false}={}) {
  const requests=[]
  const fetcher=async (url,options)=>{
    assert.equal(url,endpoint)
    assert.equal(options.redirect,'manual')
    const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers})
    const modern=options.headers['MCP-Protocol-Version']==='2026-07-28'
    assert.equal(modern,!legacy)
    assert.equal(options.headers['Mcp-Method'],body.method)
    if(modern) {
      assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28')
      assert.deepEqual(body.params._meta['io.modelcontextprotocol/clientCapabilities'],{})
      assert.equal(options.headers['Mcp-Session-Id'],undefined)
    }
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}},{headers:{'Mcp-Session-Id':'server-session'}})
    if(body.method==='notifications/initialized')return new Response(null,{status:202})
    if(legacy)assert.equal(options.headers['Mcp-Session-Id'],'server-session')
    const result=body.method==='tools/list'?{tools:tools()}:await call(body,options)
    if(result instanceof Response)return result
    return Response.json({jsonrpc:'2.0',id:body.id,result:{...(modern?{resultType:'complete'}:{}),...result}})
  }
  return {fetcher,requests}
}
async function connect(service) {
  const c=await service.put({serverId:'notes',token:'private-connector-token'})
  await service.discover({connectionId:c.id,expectedEpoch:c.epoch})
  return c
}
async function operation(service,c,id='op-1',query='note') {
  const plan=await service.plan({connectionId:c.id,expectedEpoch:c.epoch,tool:'create',arguments:{query},taskId:'task-1',runId:'run-1'})
  return service.accept(plan,{id,commandId:'command-'+id})
}

test('disabled connector service needs no secrets; configured endpoints and policies fail closed',t=>{
  const {service}=fixture(t,{env:{},fetcher:()=>{throw Error('network forbidden')}})
  assert.deepEqual(service.list(),[]);assert.deepEqual(service.tools(),[]);assert.equal(service.nextDue(),null)
  service.recover()
  for(const bad of ['http://mcp.example.com','https://127.0.0.1/mcp','https://2130706433/mcp','https://[::1]/mcp','https://mcp.local/mcp',
    'https://user:pass@mcp.example.com/mcp','https://graph.microsoft.com/mcp','https://mcp.example.com:8443/mcp']) {
    assert.throws(()=>new ConnectorService(service.store,config({endpoint:bad})),{code:'connector_url_forbidden'})
  }
  assert.throws(()=>new ConnectorService(service.store,config({tools:{send:{access:'write'}}})),{code:'connector_mail_bypass_forbidden'})
  assert.throws(()=>new ConnectorService(service.store,config({tools:{send:{access:'write',mailWrite:true}}})),{code:'connector_mail_bypass_forbidden'})
  assert.throws(()=>new ConnectorService(service.store,config({tools:{send:{access:'write',mailWrite:false,approval:'never'}}})),{code:'invalid_connector_tool_policy'})
})

test('credentials are sealed to one account and never appear in metadata, catalog or returned content',async t=>{
  const remote=mcpServer({call:()=>({content:[{type:'text',text:'echo private-connector-token'}]})})
  const alice=fixture(t,{fetcher:remote.fetcher}),bob=fixture(t,{fetcher:remote.fetcher})
  const c=await connect(alice.service)
  const serialized=JSON.stringify([alice.service.list(),alice.service.tools(),alice.store.rows('SELECT * FROM connector_connections')])
  assert.doesNotMatch(serialized,/private-connector-token/)
  assert.throws(()=>bob.service.get(c.id),{code:'connector_not_found'})
  const row=alice.store.one('SELECT * FROM connector_connections WHERE id=?',c.id)
  bob.store.rows('INSERT INTO connector_connections VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(row))
  await assert.rejects(bob.service.credential(c.id,1),{code:'vault_decryption_failed'})
  const result=await alice.service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'read'}})
  assert.deepEqual(result.content,[{type:'text',text:'echo [REDACTED]'}])
  assert.equal(remote.requests.at(-1).headers.Authorization,'Bearer private-connector-token')
  alice.service.revoke(c.id,1)
  assert.equal(alice.store.one('SELECT sealed FROM connector_connections WHERE id=?',c.id).sealed,null)
  await assert.rejects(alice.service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'read'}}),{code:'connector_changed'})
})

test('modern protocol mirrors metadata and custom headers; read-only MCP hints cannot authorize a write',async t=>{
  const withHeader={...schema,properties:{query:{type:'string','x-mcp-header':'Region'}}}
  const remote=mcpServer({tools:()=>catalog([{name:'unlisted',inputSchema:schema}]).map(tool=>tool.name==='search'?{...tool,inputSchema:withHeader}:tool)})
  const {service}=fixture(t,{fetcher:remote.fetcher})
  const c=await connect(service)
  assert.deepEqual(service.tools().map(t=>t.name).sort(),['create','review','search'])
  assert.equal(service.tools().find(t=>t.name==='create').requiresApproval,true)
  await assert.rejects(service.read({connectionId:c.id,expectedEpoch:1,tool:'create',arguments:{query:'x'}}),{code:'connector_approval_required'})
  await assert.rejects(service.read({connectionId:c.id,expectedEpoch:1,tool:'review',arguments:{query:'x'}}),{code:'connector_approval_required'})
  await assert.rejects(service.read({connectionId:c.id,expectedEpoch:1,tool:'unlisted',arguments:{query:'x'}}),{code:'connector_tool_not_allowed'})
  await service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'上海\nregion'}})
  assert.equal(remote.requests.at(-1).headers['Mcp-Name'],'search')
  assert.equal(remote.requests.at(-1).headers['Mcp-Param-Region'],'=?base64?'+Buffer.from('上海\nregion').toString('base64')+'?=')
})

test('legacy Streamable HTTP initializes once per connection epoch and uses its session',async t=>{
  const remote=mcpServer({legacy:true})
  const {service}=fixture(t,{env:config({protocolVersion:'2025-11-25'}),fetcher:remote.fetcher})
  const c=await connect(service)
  await service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'one'}})
  await service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'two'}})
  assert.equal(remote.requests.filter(r=>r.body.method==='initialize').length,1)
  assert.equal(remote.requests.filter(r=>r.body.method==='notifications/initialized').length,1)
})

test('bounded schemas support local references and composition, reject unsafe schema paths and invalid arguments before I/O',async t=>{
  const composed={type:'object',$defs:{q:{anyOf:[{type:'string',minLength:2},{type:'null'}]}},properties:{q:{$ref:'#/$defs/q'}},required:['q'],additionalProperties:false}
  inspectSchema(composed);validateArguments(composed,{q:'okay'});validateArguments(composed,{q:null})
  assert.throws(()=>validateArguments(composed,{q:'x'}),{code:'invalid_connector_arguments'})
  assert.throws(()=>validateArguments(composed,{q:1}),{code:'invalid_connector_arguments'})
  assert.throws(()=>inspectSchema({type:'object',properties:{q:{$ref:'https://evil.example.com/schema'}}}),{code:'connector_schema_external_ref'})
  assert.throws(()=>inspectSchema({type:'object',properties:{q:{type:'string',pattern:'(a+)+$'}}}),{code:'connector_schema_unsupported_keyword'})
  assert.throws(()=>inspectSchema({type:'object',properties:{q:{anyOf:[{type:'string','x-mcp-header':'X'}]}}}),{code:'connector_header_schema_invalid'})
  const remote=mcpServer(),{service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service)
  const count=remote.requests.length
  await assert.rejects(service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'x',extra:true}}),{code:'invalid_connector_arguments'})
  assert.equal(remote.requests.length,count)
})

test('write approval freezes the schema and arguments; duplicate IDs execute once and emit one final receipt',async t=>{
  let writes=0
  const remote=mcpServer({call:()=>{writes++;return {content:[{type:'text',text:'created'}]}}})
  const settled=[],{service}=fixture(t,{fetcher:remote.fetcher,options:{onSettled:op=>settled.push(op)}}),c=await connect(service)
  const args={query:'approved'}
  const plan=await service.plan({connectionId:c.id,expectedEpoch:1,tool:'create',arguments:args,taskId:'task-1',runId:'run-1'})
  args.query='mutated'
  assert.throws(()=>{plan.arguments.query='tampered'},TypeError)
  const op=service.accept(plan,{id:'op-1',commandId:'cmd-1'})
  assert.equal(op.state,'waiting_approval');assert.equal(op.arguments.query,'approved')
  await service.runNext();assert.equal(writes,0)
  service.decide({operationId:'op-1',approvalVersion:op.approvalVersion,approve:true})
  await Promise.all([service.run('op-1'),service.run('op-1')])
  assert.equal(writes,1);assert.equal(service.operation('op-1').state,'succeeded')
  assert.equal(settled.length,1);assert.equal(settled[0].taskId,'task-1');assert.equal(settled[0].runId,'run-1')
  assert.equal(service.accept(plan,{id:'op-1',commandId:'cmd-1'}).state,'succeeded')
  const different=await service.plan({connectionId:c.id,expectedEpoch:1,tool:'create',arguments:{query:'different'},taskId:'task-1',runId:'run-1'})
  assert.throws(()=>service.accept(different,{id:'op-1',commandId:'cmd-1'}),{code:'connector_operation_conflict'})
})

test('changed remote schema invalidates an approval without calling the write tool',async t=>{
  let changed=false,writes=0
  const remote=mcpServer({tools:()=>catalog().map(tool=>changed&&tool.name==='create'?{...tool,inputSchema:{...schema,required:[]}}:tool),call:()=>{writes++;return {content:[]}}})
  const {service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service),op=await operation(service,c)
  service.decide({operationId:op.operationId,approvalVersion:op.approvalVersion,approve:true});changed=true
  await service.runNext()
  assert.equal(writes,0);assert.equal(service.operation(op.operationId).state,'failed')
  assert.equal(service.operation(op.operationId).receipt.code,'connector_tool_schema_changed')
})

test('lost write response becomes unknown, blocks subsequent calls and never automatically replays',async t=>{
  let writes=0,drop=true
  const remote=mcpServer({call:()=>{writes++;if(drop)throw Error('network lost after commit');return {content:[]}}})
  const {service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service)
  for(const id of ['first','second']) {
    const op=await operation(service,c,id,id)
    service.decide({operationId:id,approvalVersion:op.approvalVersion,approve:true})
  }
  await service.runNext()
  const unknown=service.operation('first')
  assert.equal(unknown.state,'unknown');assert.equal(writes,1);assert.equal(service.nextDue(),null)
  await service.runNext();await service.run('first');assert.equal(writes,1)
  assert.equal(service.operation('second').state,'queued')
  service.reconcile({operationId:'first',approvalVersion:unknown.approvalVersion,outcome:'succeeded',evidence:'Verified note ID abc in provider'})
  drop=false;await service.runNext();assert.equal(writes,2);assert.equal(service.operation('second').state,'succeeded')
})

test('SSE notifications are bounded and a matching final response terminates an otherwise open stream',async t=>{
  const remote=mcpServer({call:body=>{
    const text=': keepalive\r\n\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progress:1}})+'\n\n'+
      'data: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{resultType:'complete',content:[{type:'text',text:'完成'}]}})+'\n\n'
    const bytes=new TextEncoder().encode(text)
    return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,bytes.length-3));controller.enqueue(bytes.slice(bytes.length-3))}}),{headers:{'Content-Type':'text/event-stream'}})
  }})
  const {service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service)
  const result=await service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'x'}})
  assert.equal(result.content[0].text,'完成')
})

test('redirects never forward a token and oversized replies fail before body consumption',async t=>{
  let calls=0
  const {service}=fixture(t,{fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://evil.example.com/steal'}})}})
  const c=await service.put({serverId:'notes',token:'private-token'})
  await assert.rejects(service.discover({connectionId:c.id,expectedEpoch:1}),{code:'connector_redirect_forbidden'})
  assert.equal(calls,1)
  service.transport.fetcher=async()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(2*1024*1024)}})
  await assert.rejects(service.discover({connectionId:c.id,expectedEpoch:1}),{code:'connector_response_too_large'})
})

function oauthConfig(overrides={}) {
  return config({oauth:{issuer,resourceMetadataUrl:'https://mcp.example.com/.well-known/oauth-protected-resource',
    metadataUrls:[issuer+'/.well-known/oauth-authorization-server'],allowedEndpoints:[issuer+'/authorize',issuer+'/token',issuer+'/register'],
    clientId:'maco-client',scopes:['notes:read','notes:write'],...overrides}})
}
function oauthServer({refresh,metadata={},grant={},registration={}}={}) {
  const calls=[]
  const fetcher=async(url,options)=>{
    calls.push({url,options})
    assert.equal(options.redirect,'manual')
    if(url.includes('oauth-protected-resource'))return Response.json({resource:endpoint,authorization_servers:[issuer],scopes_supported:['notes:read']})
    if(url.includes('oauth-authorization-server'))return Response.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',
      registration_endpoint:issuer+'/register',code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],
      authorization_response_iss_parameter_supported:true,...metadata})
    if(url.endsWith('/register'))return Response.json({client_id:'registered-client',token_endpoint_auth_method:'none',...registration})
    assert.equal(url,issuer+'/token')
    assert.equal(options.body.get('resource'),endpoint)
    if(options.body.get('grant_type')==='refresh_token' && refresh)return refresh(options)
    return Response.json({access_token:'oauth-access',refresh_token:'oauth-refresh',token_type:'Bearer',expires_in:3600,scope:'notes:read notes:write',...grant})
  }
  return {calls,fetcher}
}
test('OAuth PKCE state belongs to one account, enforces issuer before exchange and consumes a code once',async t=>{
  const remote=oauthServer(),alice=fixture(t,{env:oauthConfig(),fetcher:remote.fetcher}),bob=fixture(t,{env:oauthConfig(),fetcher:remote.fetcher})
  const start=await alice.service.beginOAuth({serverId:'notes'})
  const url=new URL(start.authorizationUrl)
  assert.equal(url.searchParams.get('code_challenge_method'),'S256')
  assert.equal(url.searchParams.get('resource'),endpoint)
  assert.equal(url.searchParams.get('redirect_uri'),'https://app.example.com/mcp/callback')
  await assert.rejects(bob.service.completeOAuth({state:start.state,code:'code',iss:issuer}),{code:'invalid_connector_oauth_state'})
  const completed=await Promise.allSettled([alice.service.completeOAuth({state:start.state,code:'code',iss:issuer}),alice.service.completeOAuth({state:start.state,code:'code',iss:issuer})])
  assert.equal(completed.filter(r=>r.status==='fulfilled').length,1)
  const tokenCalls=remote.calls.filter(r=>r.url.endsWith('/token'))
  assert.equal(tokenCalls.length,1)
  const verifier=tokenCalls[0].options.body.get('code_verifier')
  assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url'),url.searchParams.get('code_challenge'))
  assert.doesNotMatch(JSON.stringify(alice.service.list()),/oauth-access|oauth-refresh|code_verifier/)
  const bad=await alice.service.beginOAuth({serverId:'notes'})
  await assert.rejects(alice.service.completeOAuth({state:bad.state,code:'code',iss:'https://wrong.example.com'}),{code:'connector_oauth_issuer_mismatch'})
  assert.equal(remote.calls.filter(r=>r.url.endsWith('/token')).length,1)
  const missing=await alice.service.beginOAuth({serverId:'notes'})
  await assert.rejects(alice.service.completeOAuth({state:missing.state,code:'code'}),{code:'connector_oauth_issuer_mismatch'})
})

test('OAuth metadata cannot select an unlisted token destination; dynamic registration is explicit',async t=>{
  const malicious=oauthServer({metadata:{token_endpoint:'https://evil.example.com/token'}})
  const {service}=fixture(t,{env:oauthConfig(),fetcher:malicious.fetcher})
  await assert.rejects(service.beginOAuth({serverId:'notes'}),{code:'connector_endpoint_forbidden'})
  assert.equal(malicious.calls.some(call=>call.url.startsWith('https://evil.example.com')),false)
  const remote=oauthServer(),dynamic=fixture(t,{env:oauthConfig({clientId:undefined,allowDynamicRegistration:true}),fetcher:remote.fetcher})
  const start=await dynamic.service.beginOAuth({serverId:'notes'})
  assert.equal(new URL(start.authorizationUrl).searchParams.get('client_id'),'registered-client')
  const registration=remote.calls.find(call=>call.url.endsWith('/register'))
  assert.equal(JSON.parse(registration.options.body).application_type,'web')
})

test('configured OAuth clients resolve rotated strings or bindings without persisting the application secret',async t=>{
  for(const source of ['string','binding'])for(const authMethod of ['client_secret_post','client_secret_basic'])await t.test(source+' '+authMethod,async t=>{
    let value='configured-secret-A',reads=0
    const env=oauthConfig({clientSecretEnv:'NOTES_CLIENT_SECRET',tokenEndpointAuthMethod:authMethod})
    env.NOTES_CLIENT_SECRET=source==='binding'?{get:async()=>{reads++;return value}}:value
    const rotate=next=>{value=next;if(source==='string')env.NOTES_CLIENT_SECRET=next}
    const remote=oauthServer({metadata:{token_endpoint_auth_methods_supported:[authMethod]},grant:{expires_in:1}})
    const {service,store}=fixture(t,{env,fetcher:remote.fetcher})
    const start=await service.beginOAuth({serverId:'notes'})
    const flow=await service.cipher.open(['connector-oauth',start.state],store.one('SELECT sealed FROM connector_oauth WHERE state=?',start.state).sealed)
    assert.equal(reads,0)
    assert.deepEqual(flow.client,{id:'maco-client',authMethod,source:'configured',secretEnv:'NOTES_CLIENT_SECRET'})
    rotate('configured-secret-B')
    const connection=await service.completeOAuth({state:start.state,code:'code',iss:issuer})
    const exchange=remote.calls.find(call=>call.url.endsWith('/token')).options
    const sentSecret=options=>authMethod==='client_secret_post'?options.body.get('client_secret'):
      decodeURIComponent(Buffer.from(options.headers.Authorization.slice(6),'base64').toString().split(':')[1])
    assert.equal(sentSecret(exchange),'configured-secret-B')
    rotate('configured-secret-C')
    await service.credential(connection.id,connection.epoch)
    const refresh=remote.calls.filter(call=>call.url.endsWith('/token')).at(-1).options
    assert.equal(refresh.body.get('grant_type'),'refresh_token')
    assert.equal(sentSecret(refresh),'configured-secret-C')
    const persisted=await service.cipher.open(['connector','notes',connection.id],store.one('SELECT sealed FROM connector_connections WHERE id=?',connection.id).sealed)
    assert.deepEqual(persisted.oauth.client,flow.client)
    assert.doesNotMatch(JSON.stringify({flow,persisted}),/configured-secret-/)
    assert.equal(reads,source==='binding'?2:0)
  })
})

test('a failed OAuth secret lookup preserves callback state and refresh credentials for a safe retry',async t=>{
  let unavailable=true
  const env=oauthConfig({clientSecretEnv:'NOTES_CLIENT_SECRET'})
  env.NOTES_CLIENT_SECRET={get:async()=>{if(unavailable)throw Error('private upstream binding failure');return 'current-client-secret'}}
  const remote=oauthServer({metadata:{token_endpoint_auth_methods_supported:['client_secret_post']},grant:{expires_in:1}})
  const {service,store}=fixture(t,{env,fetcher:remote.fetcher})
  const start=await service.beginOAuth({serverId:'notes'})
  const retryable=error=>{
    assert.equal(error.code,'connector_oauth_client_secret_unavailable')
    assert.equal(error.status,503);assert.equal(error.beforeDispatch,true)
    assert.doesNotMatch(error.message,/private upstream/)
    return true
  }
  await assert.rejects(service.completeOAuth({state:start.state,code:'code',iss:issuer}),retryable)
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,0)
  assert.ok(store.one('SELECT state FROM connector_oauth WHERE state=?',start.state))
  unavailable=false
  const connection=await service.completeOAuth({state:start.state,code:'code',iss:issuer})
  const before=store.one('SELECT sealed,generation FROM connector_connections WHERE id=?',connection.id)
  unavailable=true
  await assert.rejects(service.credential(connection.id,connection.epoch),retryable)
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,1)
  const after=store.one('SELECT * FROM connector_connections WHERE id=?',connection.id)
  assert.equal(after.status,'active');assert.equal(after.refreshing,null)
  assert.equal(after.sealed,before.sealed);assert.equal(after.generation,before.generation)
  unavailable=false
  await service.credential(connection.id,connection.epoch)
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,2)
  assert.equal(service.get(connection.id).status,'active')
})

test('revoking a request session during an OAuth secret lookup prevents code exchange and persistence',async t=>{
  let started,release,allowed=true
  const began=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
  const env=oauthConfig({clientSecretEnv:'NOTES_CLIENT_SECRET'})
  env.NOTES_CLIENT_SECRET={get:async()=>{started();await gate;return 'private-secret'}}
  const remote=oauthServer({metadata:{token_endpoint_auth_methods_supported:['client_secret_post']}})
  const {service,store}=fixture(t,{env,fetcher:remote.fetcher})
  const start=await service.beginOAuth({serverId:'notes'})
  const assertAuthorized=()=>{if(!allowed)throw Object.assign(Error('revoked session'),{code:'session_revoked'})}
  const rejected=assert.rejects(service.completeOAuth({state:start.state,code:'code',iss:issuer},{assertAuthorized}),{code:'session_revoked'})
  await began;allowed=false;release();await rejected
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,0)
  assert.equal(service.list().length,0)
  assert.ok(store.one('SELECT state FROM connector_oauth WHERE state=?',start.state))
})

test('revoking a connector during a slow secret lookup prevents refresh dispatch without an uncertain-outcome marker',async t=>{
  let started,release,blocked=false
  const began=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
  const env=oauthConfig({clientSecretEnv:'NOTES_CLIENT_SECRET'})
  env.NOTES_CLIENT_SECRET={get:async()=>{if(blocked){started();await gate}return 'private-secret'}}
  const remote=oauthServer({metadata:{token_endpoint_auth_methods_supported:['client_secret_post']},grant:{expires_in:1}})
  const {service,store}=fixture(t,{env,fetcher:remote.fetcher})
  const start=await service.beginOAuth({serverId:'notes'}),connection=await service.completeOAuth({state:start.state,code:'code',iss:issuer})
  blocked=true
  const rejected=assert.rejects(service.credential(connection.id,connection.epoch),{code:'connector_changed'})
  await began
  assert.equal(store.one('SELECT refreshing FROM connector_connections WHERE id=?',connection.id).refreshing,null)
  service.revoke(connection.id,connection.epoch);release();await rejected
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,1)
  const after=store.one('SELECT * FROM connector_connections WHERE id=?',connection.id)
  assert.equal(after.status,'revoked');assert.equal(after.sealed,null);assert.equal(after.refreshing,null)
})

test('legacy configured grants migrate to the current operator reference only for the same client and issuer',async t=>{
  for(const change of ['none','client','issuer','resource'])await t.test(change,async t=>{
    let reads=0
    const env=oauthConfig({clientSecretEnv:'NOTES_CLIENT_SECRET'})
    env.NOTES_CLIENT_SECRET={get:async()=>{reads++;return 'current-operator-secret'}}
    const remote=oauthServer(),{service,store}=fixture(t,{env,fetcher:remote.fetcher})
    const secret={kind:'oauth',accessToken:'expired-access',refreshToken:'legacy-refresh',expiresAt:1,scopes:['notes:read','notes:write'],oauth:{
      issuer:change==='issuer'?'https://old-auth.example.com':issuer,resource:change==='resource'?'https://old-mcp.example.com/mcp':endpoint,
      tokenEndpoint:issuer+'/token',client:{id:change==='client'?'old-client':'maco-client',authMethod:'client_secret_post',secret:'legacy-embedded-secret'}}}
    const connection=await service.saveCredential({id:crypto.randomUUID(),serverId:'notes',secret})
    if(change==='none') {
      await service.credential(connection.id,connection.epoch)
      assert.equal(reads,1)
      assert.equal(remote.calls[0].options.body.get('client_secret'),'current-operator-secret')
      const persisted=await service.cipher.open(['connector','notes',connection.id],store.one('SELECT sealed FROM connector_connections WHERE id=?',connection.id).sealed)
      assert.deepEqual(persisted.oauth.client,{id:'maco-client',authMethod:'client_secret_post',source:'configured',secretEnv:'NOTES_CLIENT_SECRET'})
      assert.doesNotMatch(JSON.stringify(persisted),/legacy-embedded-secret|current-operator-secret/)
    } else {
      const code=change==='client'?'connector_reauthorization_required':change==='issuer'?'connector_oauth_issuer_mismatch':'connector_oauth_resource_mismatch'
      await assert.rejects(service.credential(connection.id,connection.epoch),{code})
      assert.equal(reads,0);assert.equal(remote.calls.length,0)
      assert.equal(service.get(connection.id).status,'active')
      assert.equal(store.one('SELECT refreshing FROM connector_connections WHERE id=?',connection.id).refreshing,null)
    }
  })
})

test('dynamically registered client secrets stay bound to their grant when an operator adds a configured client',async t=>{
  const remote=oauthServer({metadata:{token_endpoint_auth_methods_supported:['client_secret_post']},grant:{expires_in:1},
    registration:{token_endpoint_auth_method:'client_secret_post',client_secret:'registered-client-secret'}})
  const {service,store,env}=fixture(t,{env:oauthConfig({clientId:undefined,allowDynamicRegistration:true}),fetcher:remote.fetcher})
  const start=await service.beginOAuth({serverId:'notes'}),connection=await service.completeOAuth({state:start.state,code:'code',iss:issuer})
  assert.equal(remote.calls.find(call=>call.url.endsWith('/token')).options.body.get('client_secret'),'registered-client-secret')
  const nextEnv={...env,...oauthConfig({clientId:'different-operator-client',clientSecretEnv:'NOTES_CLIENT_SECRET',allowDynamicRegistration:true})}
  nextEnv.NOTES_CLIENT_SECRET={get:()=>{throw Error('must not replace the registered client secret')}}
  const reconstructed=new ConnectorService(store,nextEnv,{fetcher:remote.fetcher})
  const credential=await reconstructed.credential(connection.id,connection.epoch)
  const refresh=remote.calls.filter(call=>call.url.endsWith('/token')).at(-1).options
  assert.equal(refresh.body.get('client_id'),'registered-client')
  assert.equal(refresh.body.get('client_secret'),'registered-client-secret')
  assert.equal(credential.oauth.client.source,'dynamic')
  assert.equal(credential.oauth.client.secretEnv,undefined)
})

test('one durable refresh owner serves concurrent calls; revocation wins over a late token rotation',async t=>{
  let release,started,refreshes=0
  const gate=new Promise(resolve=>{release=resolve}),began=new Promise(resolve=>{started=resolve})
  const remote=oauthServer({grant:{expires_in:1},refresh:async()=>{
    refreshes++;started();await gate
    return Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600,scope:'notes:read notes:write'})
  }})
  const {service,store}=fixture(t,{env:oauthConfig(),fetcher:remote.fetcher})
  const start=await service.beginOAuth({serverId:'notes'}),c=await service.completeOAuth({state:start.state,code:'code',iss:issuer})
  const attempts=Promise.allSettled(Array.from({length:6},()=>service.credential(c.id,1)))
  await began
  assert.ok(store.one('SELECT refreshing FROM connector_connections WHERE id=?',c.id).refreshing)
  service.revoke(c.id,1);release()
  for(const result of await attempts)assert.equal(result.status,'rejected')
  assert.equal(refreshes,1);assert.equal(service.get(c.id).status,'revoked')
  assert.equal(store.one('SELECT sealed FROM connector_connections WHERE id=?',c.id).sealed,null)
})

test('recovery never retries a consumed rotating refresh or a dispatched connector write; erasure removes all user data',async t=>{
  const remote=mcpServer(),{service,store,env}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service)
  const op=await operation(service,c)
  const raw=service.rawOperation(op.operationId);raw.state='dispatching';store.tx(()=>service.saveOperation(raw))
  store.rows('UPDATE connector_connections SET refreshing=? WHERE id=?','interrupted-refresh',c.id)
  const reconstructed=new ConnectorService(store,env,{fetcher:()=>{throw Error('must not retry')}})
  reconstructed.recover()
  assert.equal(reconstructed.operation(op.operationId).state,'unknown')
  assert.equal(reconstructed.get(c.id).status,'reauthorization_required')
  assert.equal(reconstructed.nextDue(),null)
  reconstructed.erase()
  assert.deepEqual(reconstructed.list(),[]);assert.equal(reconstructed.operationPage().operations.length,0)
  for(const table of ['connector_connections','connector_tools','connector_oauth','connector_operations'])assert.equal(store.one('SELECT COUNT(*) count FROM '+table).count,0)
})

test('account erasure fences an OAuth exchange already accepted by the remote issuer',async t=>{
  const remote=oauthServer()
  let released,started
  const gate=new Promise(resolve=>{released=resolve}),began=new Promise(resolve=>{started=resolve})
  const fetcher=async(url,options)=>{
    if(url.endsWith('/token')) {started();await gate}
    return remote.fetcher(url,options)
  }
  const {service}=fixture(t,{env:oauthConfig(),fetcher})
  const start=await service.beginOAuth({serverId:'notes'})
  const pending=service.completeOAuth({state:start.state,code:'code',iss:issuer})
  const rejected=assert.rejects(pending,{code:'connector_lifecycle_changed'})
  await began;service.erase();released();await rejected
  assert.deepEqual(service.list(),[])
})

test('account erasure also fences discovery before a new OAuth state is persisted',async t=>{
  const remote=oauthServer()
  let released,started
  const gate=new Promise(resolve=>{released=resolve}),began=new Promise(resolve=>{started=resolve})
  const fetcher=async(url,options)=>{
    if(url.includes('oauth-authorization-server')) {started();await gate}
    return remote.fetcher(url,options)
  }
  const {service,store}=fixture(t,{env:oauthConfig(),fetcher})
  const pending=service.beginOAuth({serverId:'notes'})
  const rejected=assert.rejects(pending,{code:'connector_lifecycle_changed'})
  await began;service.erase();released();await rejected
  assert.equal(store.one('SELECT COUNT(*) count FROM connector_oauth').count,0)
})

test('reset fences late write results while retaining credentials and an unknown-operation receipt',async t=>{
  let released,started
  const gate=new Promise(resolve=>{released=resolve}),began=new Promise(resolve=>{started=resolve})
  const remote=mcpServer({call:async()=>{started();await gate;return {content:[{type:'text',text:'late private result'}]}}})
  const {service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service),op=await operation(service,c)
  service.decide({operationId:op.operationId,approvalVersion:op.approvalVersion,approve:true})
  const running=service.run(op.operationId)
  await began
  assert.equal(service.activeCount(),1)
  service.fence()
  assert.equal(service.get(c.id).status,'active')
  assert.equal(service.operation(op.operationId).state,'unknown')
  released();await running
  assert.equal(service.activeCount(),0)
  assert.equal(service.operation(op.operationId).state,'unknown')
  assert.doesNotMatch(JSON.stringify(service.operation(op.operationId)),/late private result/)
  service.fence({revokeConnections:true})
  assert.equal(service.get(c.id).status,'revoked')
  assert.equal(service.pendingStatus().unknown,1)
})

test('revoking the request session prevents a token replacement after encryption and catalog persistence after I/O',async t=>{
  const remote=mcpServer(),{service,store}=fixture(t,{fetcher:remote.fetcher})
  const c=await service.put({serverId:'notes',token:'valid-token'})
  const original=store.one('SELECT sealed FROM connector_connections WHERE id=?',c.id).sealed
  let allowed=true,release,began
  const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{began=resolve})
  const seal=service.cipher.seal.bind(service.cipher)
  service.cipher.seal=async(...args)=>{const value=await seal(...args);began();await gate;return value}
  const assertAuthorized=()=>{if(!allowed)throw Object.assign(Error('revoked session'),{code:'session_revoked'})}
  const replace=service.put({id:c.id,expectedEpoch:1,serverId:'notes',token:'uncommitted-token'},{assertAuthorized})
  const rejected=assert.rejects(replace,{code:'session_revoked'})
  await started;allowed=false;release();await rejected
  assert.equal(service.get(c.id).epoch,1)
  assert.equal(store.one('SELECT sealed FROM connector_connections WHERE id=?',c.id).sealed,original)
  service.cipher.seal=seal
  allowed=true
  service.transport.fetcher=async(...args)=>{const response=await remote.fetcher(...args);allowed=false;return response}
  await assert.rejects(service.discover({connectionId:c.id,expectedEpoch:1},{assertAuthorized}),{code:'session_revoked'})
  assert.deepEqual(service.tools(),[])
  const requests=remote.requests.length
  await assert.rejects(service.discover({connectionId:c.id,expectedEpoch:1},{assertAuthorized}),{code:'session_revoked'})
  assert.equal(remote.requests.length,requests)
})

test('OAuth checks the request session between discovery calls and after an accepted token response',async t=>{
  let allowed=true,block='metadata'
  const remote=oauthServer()
  const assertAuthorized=()=>{if(!allowed)throw Object.assign(Error('revoked session'),{code:'session_revoked'})}
  const fetcher=async(url,options)=>{
    const response=await remote.fetcher(url,options)
    if(block==='metadata'&&url.includes('oauth-authorization-server')||block==='token'&&url.endsWith('/token'))allowed=false
    return response
  }
  const {service,store}=fixture(t,{env:oauthConfig({clientId:undefined,allowDynamicRegistration:true}),fetcher})
  await assert.rejects(service.beginOAuth({serverId:'notes'},{assertAuthorized}),{code:'session_revoked'})
  assert.equal(remote.calls.some(call=>call.url.endsWith('/register')),false)
  assert.equal(store.one('SELECT COUNT(*) count FROM connector_oauth').count,0)
  allowed=true;block='token'
  const start=await service.beginOAuth({serverId:'notes'},{assertAuthorized})
  await assert.rejects(service.completeOAuth({state:start.state,code:'code',iss:issuer},{assertAuthorized}),{code:'session_revoked'})
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/token')).length,1)
  assert.deepEqual(service.list(),[])
  assert.equal(store.one('SELECT COUNT(*) count FROM connector_oauth').count,0)
})

test('a read result cannot cross a revoked request session even when the connector replies successfully',async t=>{
  let allowed=true
  const remote=mcpServer({call:()=>{allowed=false;return {content:[{type:'text',text:'private result'}]}}})
  const {service}=fixture(t,{fetcher:remote.fetcher}),c=await connect(service)
  const assertAuthorized=()=>{if(!allowed)throw Object.assign(Error('revoked session'),{code:'session_revoked'})}
  await assert.rejects(service.read({connectionId:c.id,expectedEpoch:1,tool:'search',arguments:{query:'read'}},{assertAuthorized}),{code:'session_revoked'})
})

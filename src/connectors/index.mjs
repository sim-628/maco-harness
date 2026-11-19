import { VaultCipher, failure, nonce } from '../connections/crypto.mjs'
import { errorCode, fingerprint, identifier } from '../protocol.mjs'
import { beginAuthorization, checkIssuer, redeemAuthorization, refreshAuthorization } from './oauth.mjs'
import { McpTransport } from './transport.mjs'
import { inspectSchema, toolHeaders, validateArguments } from './schema.mjs'
import { boundedString, check, isObject, jsonBytes, LIMITS, loadServers, secretString } from './policy.mjs'

const finalStates=new Set(['succeeded','failed','unknown','rejected','cancelled'])
const clone=value=>JSON.parse(JSON.stringify(value))
const freeze=value=>{
  if(value&&typeof value==='object') {for(const child of Object.values(value))freeze(child);Object.freeze(value)}
  return value
}
const schema=[
  'CREATE TABLE IF NOT EXISTS connector_identity (singleton INTEGER PRIMARY KEY, binding TEXT NOT NULL, lifecycle INTEGER NOT NULL DEFAULT 1)',
  `CREATE TABLE IF NOT EXISTS connector_connections (
    id TEXT PRIMARY KEY, server TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL,
    epoch INTEGER NOT NULL, generation TEXT NOT NULL, auth TEXT NOT NULL, sealed TEXT,
    scopes TEXT NOT NULL, refreshing TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS connector_tools (connection TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(connection,name))',
  'CREATE TABLE IF NOT EXISTS connector_oauth (state TEXT PRIMARY KEY, connection TEXT NOT NULL, expires INTEGER NOT NULL, sealed TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS connector_operations (id TEXT PRIMARY KEY, state TEXT NOT NULL, due INTEGER NOT NULL, connection TEXT NOT NULL, task TEXT, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS connector_operations_due ON connector_operations(state,due)',
  'CREATE INDEX IF NOT EXISTS connector_operations_connection ON connector_operations(connection,state)',
]
export function connectorOperationView(op) {
  if (!op) return null
  const {id,connectionId,taskId,runId,commandId,tool,arguments:args,state,version,receipt,createdAt,updatedAt,approvedAt}=op
  return {operationId:id,kind:'connector',connectionId,taskId,runId,commandId,tool,arguments:args,
    state,approvalVersion:version,receipt,createdAt,updatedAt,approvedAt}
}
function redact(value,secret) {
  if (!secret) return value
  let count=0
  function visit(item,depth=0) {
    check(++count<=30000 && depth<=40,'connector_response_too_complex',502)
    if (typeof item==='string') return item.split(secret).join('[REDACTED]')
    if (Array.isArray(item)) return item.map(child=>visit(child,depth+1))
    if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([key,child])=>[key.split(secret).join('[REDACTED]'),visit(child,depth+1)]))
    return item
  }
  return visit(value)
}
function resultView(value,secret) {
  check(isObject(value) && (value.content===undefined || Array.isArray(value.content)),'connector_invalid_tool_result',502)
  const content=value.content ?? []
  check(content.length<=128,'connector_result_too_large',502)
  const allowed=new Set(['text','image','audio','resource','resource_link'])
  for (const item of content) check(isObject(item) && allowed.has(item.type) &&
    (item.type!=='text'||typeof item.text==='string'),'connector_invalid_tool_result',502)
  const result={content,...(Object.hasOwn(value,'structuredContent')?{structuredContent:value.structuredContent}:{}),isError:value.isError===true}
  jsonBytes(result,LIMITS.responseBytes,'connector_result_too_large')
  return redact(result,secret)
}

/** One instance belongs to one account DO. The caller owns the only alarm and
 * transaction boundary; no connector starts its own timer or execution loop. */
export class ConnectorService {
  constructor(store,env,{fetcher=fetch,now=Date.now,onSettled=()=>{},assertOwner=()=>{}}={}) {
    Object.assign(this,{store,env,fetcher,now,onSettled,assertOwner})
    this.serverPolicies=loadServers(env)
    this.transport=new McpTransport(fetcher)
    this.refreshing=new Map(); this.running=new Map(); this.plans=new WeakSet()
    this.maxConnections=32; this.maxOperations=256
    store.tx(()=>{
      for (const statement of schema) store.rows(statement)
      if(!store.rows('PRAGMA table_info(connector_identity)').some(column=>column.name==='lifecycle'))store.rows('ALTER TABLE connector_identity ADD COLUMN lifecycle INTEGER NOT NULL DEFAULT 1')
      store.rows('INSERT OR IGNORE INTO connector_identity(singleton,binding) VALUES (1,?)',crypto.randomUUID())
    })
    this.cipher=new VaultCipher(env.CONNECTOR_ENCRYPTION_KEY ?? env.CONNECTION_ENCRYPTION_KEY,
      store.one('SELECT binding FROM connector_identity WHERE singleton=1').binding)
  }
  servers() {
    return [...this.serverPolicies.values()].map(server=>({serverId:server.id,label:server.label,endpoint:server.endpoint,
      protocolVersion:server.protocolVersion,oauth:!!server.oauth,allowAnonymous:server.allowAnonymous}))
  }
  server(id) {
    const server=this.serverPolicies.get(id)
    check(server,'connector_server_not_allowed',403)
    return server
  }
  lifecycle() {
    const row=this.store.one('SELECT binding,lifecycle FROM connector_identity WHERE singleton=1')
    return row ? row.binding+':'+row.lifecycle : undefined
  }
  assertLifecycle(value) { check(typeof value==='string' && this.lifecycle()===value,'connector_lifecycle_changed',409) }
  row(id) {
    identifier(id,'connector_id')
    const row=this.store.one('SELECT * FROM connector_connections WHERE id=?',id)
    check(row,'connector_not_found',404)
    return row
  }
  get(id) {
    const row=this.row(id), server=this.serverPolicies.get(row.server)
    return {id:row.id,kind:'connector',provider:'mcp',serverId:row.server,label:server?.label ?? row.server,
      endpoint:row.endpoint,status:row.status,epoch:row.epoch,authType:row.auth,scopes:JSON.parse(row.scopes),
      configured:!!server && server.endpoint===row.endpoint,createdAt:row.created,updatedAt:row.updated}
  }
  list() { return this.store.rows('SELECT id FROM connector_connections ORDER BY created,id').map(({id})=>this.get(id)) }
  assertEpoch(id,expectedEpoch) {
    const row=this.row(id)
    check(Number.isSafeInteger(expectedEpoch) && row.epoch===expectedEpoch,'connector_changed',409)
    check(row.status==='active','connector_revoked',403)
    const server=this.server(row.server)
    check(server.endpoint===row.endpoint,'connector_endpoint_changed',409)
    return row
  }
  assertReplacement(id,expectedEpoch,serverId) {
    const row=this.row(id)
    check(row.epoch===expectedEpoch && Number.isSafeInteger(expectedEpoch),'connector_changed',409)
    check(row.server===serverId,'connector_server_mismatch',409)
    return row
  }
  capacity() {
    check(this.store.one('SELECT COUNT(*) count FROM connector_connections').count<this.maxConnections,'connector_capacity_reached',429)
  }
  updated(id) { const value=this.get(id); this.store.event('connector.updated',{connection:value}); return value }
  async saveCredential({id,expectedEpoch,serverId,secret,lifecycle=this.lifecycle()},{assertAuthorized}={}) {
    assertAuthorized?.()
    const server=this.server(serverId)
    if (expectedEpoch!==undefined) this.assertReplacement(id,expectedEpoch,serverId)
    else { check(!this.store.one('SELECT 1 FROM connector_connections WHERE id=?',id),'connector_changed',409); this.capacity() }
    const sealed=await this.cipher.seal(['connector',serverId,id],secret)
    return this.store.tx(()=>{
      assertAuthorized?.()
      this.assertLifecycle(lifecycle)
      if (expectedEpoch!==undefined) {
        this.assertReplacement(id,expectedEpoch,serverId)
        this.store.rows(`UPDATE connector_connections SET endpoint=?,status='active',epoch=epoch+1,generation=?,
          auth=?,sealed=?,scopes=?,refreshing=NULL,updated=? WHERE id=?`,server.endpoint,nonce(),secret.kind,sealed,JSON.stringify(secret.scopes ?? []),this.now(),id)
      } else {
        this.capacity()
        this.store.rows('INSERT INTO connector_connections VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          id,serverId,server.endpoint,'active',1,nonce(),secret.kind,sealed,JSON.stringify(secret.scopes ?? []),null,this.now(),this.now())
      }
      this.store.rows('DELETE FROM connector_tools WHERE connection=?',id)
      this.transport.forget(id)
      return this.updated(id)
    })
  }
  async put({id,expectedEpoch,serverId,token},{assertAuthorized}={}) {
    assertAuthorized?.()
    const server=this.server(serverId)
    if (id!==undefined) this.assertReplacement(id,expectedEpoch,serverId)
    else check(expectedEpoch===undefined,'connector_changed',409)
    const secret=token===undefined ? (check(server.allowAnonymous,'connector_token_required'),{kind:'none',scopes:[]}) :
      {kind:'token',accessToken:secretString(token),scopes:[]}
    return this.saveCredential({id:id ?? crypto.randomUUID(),expectedEpoch,serverId,secret},{assertAuthorized})
  }
  async beginOAuth({id,expectedEpoch,serverId,signal}={}, {assertAuthorized}={}) {
    const lifecycle=this.lifecycle()
    const assertCurrent=()=>{assertAuthorized?.();this.assertLifecycle(lifecycle)}
    assertCurrent()
    const server=this.server(serverId)
    if (id!==undefined) this.assertReplacement(id,expectedEpoch,serverId)
    else { check(expectedEpoch===undefined,'connector_changed',409); this.capacity() }
    this.store.tx(()=>this.store.rows('DELETE FROM connector_oauth WHERE expires<=?',this.now()))
    check(this.store.one('SELECT COUNT(*) count FROM connector_oauth').count<16,'connector_oauth_capacity_reached',429)
    const started=await beginAuthorization(server,this.env,this.fetcher,{signal,assertAuthorized:assertCurrent})
    const connectionId=id ?? crypto.randomUUID()
    const policyDigest=await fingerprint({endpoint:server.endpoint,oauth:server.oauth})
    const sealed=await this.cipher.seal(['connector-oauth',started.state],{...started.flow,id:connectionId,expectedEpoch,serverId,policyDigest,lifecycle})
    this.store.tx(()=>{
      assertCurrent()
      if(id!==undefined)this.assertReplacement(id,expectedEpoch,serverId)
      check(this.store.one('SELECT COUNT(*) count FROM connector_oauth').count<16,'connector_oauth_capacity_reached',429)
      this.store.rows('INSERT INTO connector_oauth VALUES (?,?,?,?)',started.state,connectionId,this.now()+600000,sealed)
    })
    return {state:started.state,authorizationUrl:started.authorizationUrl,expiresAt:this.now()+600000}
  }
  async completeOAuth({state,code,iss,signal}={}, {assertAuthorized}={}) {
    assertAuthorized?.()
    check(typeof state==='string' && /^[\w-]{43}$/.test(state),'invalid_connector_oauth_state')
    boundedString(code,8192,'invalid_connector_oauth_code')
    const saved=this.store.tx(()=>{
      const row=this.store.one('SELECT * FROM connector_oauth WHERE state=?',state)
      this.store.rows('DELETE FROM connector_oauth WHERE state=?',state)
      return row
    })
    check(saved && saved.expires>this.now(),'invalid_connector_oauth_state')
    const flow=await this.cipher.open(['connector-oauth',state],saved.sealed)
    const assertCurrent=()=>{assertAuthorized?.();this.assertLifecycle(flow.lifecycle)}
    assertCurrent()
    const server=this.server(flow.serverId)
    check(await fingerprint({endpoint:server.endpoint,oauth:server.oauth})===flow.policyDigest,'connector_oauth_policy_changed',409)
    checkIssuer(flow,iss)
    if(flow.expectedEpoch!==undefined)this.assertReplacement(flow.id,flow.expectedEpoch,flow.serverId)
    const secret=await redeemAuthorization(server,flow,code,this.fetcher,{signal,now:this.now(),assertAuthorized:assertCurrent})
    return this.saveCredential({id:flow.id,expectedEpoch:flow.expectedEpoch,serverId:flow.serverId,secret,lifecycle:flow.lifecycle},{assertAuthorized:assertCurrent})
  }
  revoke(input,expectedEpoch) {
    const id=typeof input==='string'?input:input.id
    expectedEpoch=typeof input==='string'?expectedEpoch:input.expectedEpoch
    return this.store.tx(()=>{
      const row=this.row(id)
      check(Number.isSafeInteger(expectedEpoch) && row.epoch===expectedEpoch,'connector_changed',409)
      if(row.status!=='revoked')this.store.rows("UPDATE connector_connections SET status='revoked',epoch=epoch+1,sealed=NULL,generation=?,refreshing=NULL,updated=? WHERE id=?",nonce(),this.now(),id)
      this.store.rows('DELETE FROM connector_tools WHERE connection=?',id)
      this.store.rows('DELETE FROM connector_oauth WHERE connection=?',id)
      this.transport.forget(id)
      for(const {data} of this.store.rows("SELECT data FROM connector_operations WHERE connection=? AND state IN ('queued','waiting_approval')",id)) this.settle(JSON.parse(data),{status:'cancelled',code:'connector_revoked'})
      for(const entry of this.running.values())if(entry.connectionId===id)entry.controller.abort()
      return this.updated(id)
    })
  }
  async credential(id,epoch,{signal,assertAuthorized}={}) {
    assertAuthorized?.()
    const row=this.assertEpoch(id,epoch)
    const secret=await this.cipher.open(['connector',row.server,id],row.sealed)
    const current=this.assertEpoch(id,epoch)
    assertAuthorized?.()
    if(current.generation!==row.generation)return this.credential(id,epoch,{signal,assertAuthorized})
    if(secret.kind!=='oauth'||secret.expiresAt>this.now()+60000)return secret
    let flight=this.refreshing.get(row.generation)
    if(!flight) {
      check(!row.refreshing,'connector_refresh_unknown',409)
      flight=this.refresh(row,secret,{signal,assertAuthorized}).finally(()=>this.refreshing.delete(row.generation))
      this.refreshing.set(row.generation,flight)
    }
    const next=await flight
    assertAuthorized?.()
    this.assertEpoch(id,epoch)
    return next
  }
  async refresh(row,secret,{signal,assertAuthorized}) {
    assertAuthorized?.()
    this.store.tx(()=>{
      const current=this.assertEpoch(row.id,row.epoch)
      check(current.generation===row.generation && !current.refreshing,'connector_changed',409)
      this.store.rows('UPDATE connector_connections SET refreshing=? WHERE id=?',nonce(),row.id)
    })
    let renewed,dispatched=false
    try {
      await this.assertOwner({connectionId:row.id,signal})
      assertAuthorized?.()
      dispatched=true
      renewed=await refreshAuthorization(this.server(row.server),secret,this.fetcher,{signal,now:this.now(),assertAuthorized})
      const sealed=await this.cipher.seal(['connector',row.server,row.id],renewed)
      this.store.tx(()=>{
        assertAuthorized?.()
        const current=this.assertEpoch(row.id,row.epoch)
        check(current.generation===row.generation,'connector_changed',409)
        const scopes=JSON.stringify(renewed.scopes)
        this.store.rows('UPDATE connector_connections SET sealed=?,generation=?,scopes=?,epoch=epoch+?,refreshing=NULL,updated=? WHERE id=?',
          sealed,nonce(),scopes,scopes===current.scopes?0:1,this.now(),row.id)
        if(scopes!==current.scopes) { this.store.rows('DELETE FROM connector_tools WHERE connection=?',row.id); this.updated(row.id) }
      })
      return renewed
    } catch(error) {
      this.store.tx(()=>{
        const current=this.store.one('SELECT * FROM connector_connections WHERE id=?',row.id)
        if(current?.generation!==row.generation||current.status!=='active')return
        if(!dispatched||error.httpStatus===429) this.store.rows('UPDATE connector_connections SET refreshing=NULL WHERE id=?',row.id)
        else {
          // A rotating refresh token may already have been consumed. Neither a
          // retry nor a DO restart may silently reuse the stale credential.
          this.store.rows("UPDATE connector_connections SET status='reauthorization_required',epoch=epoch+1,sealed=NULL,refreshing=NULL,updated=? WHERE id=?",this.now(),row.id)
          this.store.rows('DELETE FROM connector_tools WHERE connection=?',row.id)
          this.updated(row.id)
        }
      })
      throw error
    }
  }
  tools(connectionId) {
    if(connectionId!==undefined)this.row(connectionId)
    const rows=connectionId===undefined?this.store.rows("SELECT t.data,c.id,c.epoch,c.server,c.endpoint FROM connector_tools t JOIN connector_connections c ON c.id=t.connection WHERE c.status='active' ORDER BY c.id,t.name"):
      this.store.rows("SELECT t.data,c.id,c.epoch,c.server,c.endpoint FROM connector_tools t JOIN connector_connections c ON c.id=t.connection WHERE c.id=? AND c.status='active' ORDER BY t.name",connectionId)
    return rows.flatMap(row=>{
      const server=this.serverPolicies.get(row.server), tool=JSON.parse(row.data), policy=server?.tools.get(tool.name)
      if(!policy||server.endpoint!==row.endpoint)return []
      return [{...tool,connectionId:row.id,epoch:row.epoch,...policy}]
    })
  }
  async discover({connectionId,expectedEpoch,signal}={}, {assertAuthorized}={}) {
    const lifecycle=this.lifecycle()
    const assertCurrent=()=>{assertAuthorized?.();this.assertLifecycle(lifecycle);this.assertEpoch(connectionId,expectedEpoch)}
    assertCurrent()
    const row=this.assertEpoch(connectionId,expectedEpoch), server=this.server(row.server)
    const credential=await this.credential(connectionId,expectedEpoch,{signal,assertAuthorized:assertCurrent})
    const found=[], excluded=[], seen=new Set(), cursors=new Set()
    let cursor
    for(let page=0;page<LIMITS.pages;page++) {
      this.assertEpoch(connectionId,expectedEpoch)
      await this.assertOwner({connectionId,signal})
      const result=await this.transport.request(server,credential,'tools/list',cursor?{cursor}:{},{connectionId,epoch:expectedEpoch,signal,assertAuthorized:assertCurrent})
      check(Array.isArray(result.tools),'connector_invalid_catalog',502)
      for(const raw of result.tools) {
        check(seen.size<LIMITS.tools,'connector_catalog_too_large',502)
        check(isObject(raw) && typeof raw.name==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(raw.name) && !seen.has(raw.name),'connector_invalid_catalog',502)
        seen.add(raw.name)
        const policy=server.tools.get(raw.name)
        if(!policy) {excluded.push({name:raw.name,code:'tool_not_allowed'});continue}
        try { inspectSchema(raw.inputSchema);if(raw.outputSchema!==undefined)inspectSchema(raw.outputSchema,{objectRoot:false}) }
        catch(error) {excluded.push({name:raw.name,code:errorCode(error,'connector_schema_unsupported')});continue}
        const inputSchema=redact(raw.inputSchema,credential.accessToken)
        const outputSchema=raw.outputSchema===undefined?undefined:redact(raw.outputSchema,credential.accessToken)
        const tool={name:raw.name,description:redact(typeof raw.description==='string'?raw.description.slice(0,2000):raw.name,credential.accessToken),inputSchema,
          ...(outputSchema?{outputSchema}:{}),schemaDigest:await fingerprint({inputSchema,outputSchema}),discoveredAt:this.now()}
        found.push(tool)
        jsonBytes(found,LIMITS.catalogBytes,'connector_catalog_too_large')
      }
      cursor=result.nextCursor
      if(cursor===undefined||cursor===null||cursor==='')break
      check(typeof cursor==='string' && cursor.length<=2048 && !cursors.has(cursor),'connector_invalid_cursor',502)
      cursors.add(cursor)
      check(page<LIMITS.pages-1,'connector_catalog_incomplete',502)
    }
    this.assertEpoch(connectionId,expectedEpoch)
    await this.assertOwner({connectionId,signal})
    this.store.tx(()=>{
      assertCurrent()
      this.assertEpoch(connectionId,expectedEpoch)
      this.store.rows('DELETE FROM connector_tools WHERE connection=?',connectionId)
      for(const tool of found)this.store.rows('INSERT INTO connector_tools VALUES (?,?,?)',connectionId,tool.name,JSON.stringify(tool))
      this.store.event('connector.tools.updated',{connectionId,epoch:expectedEpoch,count:found.length})
    })
    return {connection:this.get(connectionId),tools:this.tools(connectionId),excluded}
  }
  tool(connectionId,epoch,name) {
    const row=this.assertEpoch(connectionId,epoch), server=this.server(row.server)
    const policy=server.tools.get(name)
    check(policy,'connector_tool_not_allowed',403)
    const found=this.store.one('SELECT data FROM connector_tools WHERE connection=? AND name=?',connectionId,name)
    check(found,'connector_discovery_required',409)
    return {row,server,policy,tool:JSON.parse(found.data)}
  }
  async read({connectionId,expectedEpoch,tool:name,arguments:args={},signal,taskId,runId}={}, {assertAuthorized}={}) {
    const lifecycle=this.lifecycle()
    const assertCurrent=()=>{assertAuthorized?.();this.assertLifecycle(lifecycle);this.assertEpoch(connectionId,expectedEpoch)}
    assertCurrent()
    const {server,policy,tool}=this.tool(connectionId,expectedEpoch,name)
    check(policy.access==='read' && !policy.requiresApproval,'connector_approval_required',403)
    validateArguments(tool.inputSchema,args)
    const credential=await this.credential(connectionId,expectedEpoch,{signal,assertAuthorized:assertCurrent})
    const prepared=await this.transport.prepare(server,credential,{connectionId,epoch:expectedEpoch,signal,assertAuthorized:assertCurrent})
    this.assertEpoch(connectionId,expectedEpoch)
    await this.assertOwner({connectionId,taskId,runId,signal})
    assertCurrent()
    const result=await this.transport.request(server,credential,'tools/call',{name,arguments:clone(args)},
      {connectionId,epoch:expectedEpoch,signal,prepared,headers:toolHeaders(tool.inputSchema,args),assertAuthorized:assertCurrent})
    this.assertEpoch(connectionId,expectedEpoch)
    await this.assertOwner({connectionId,taskId,runId,signal})
    assertCurrent()
    if(tool.outputSchema)validateArguments(tool.outputSchema,result.structuredContent,{objectRoot:false,maxBytes:LIMITS.responseBytes})
    return resultView(result,credential.accessToken)
  }
  async plan({connectionId,expectedEpoch,tool:name,arguments:args={},taskId,runId}={}) {
    const {server,policy,tool}=this.tool(connectionId,expectedEpoch,name)
    validateArguments(tool.inputSchema,args)
    const frozen=clone(args)
    const policyDigest=await fingerprint({endpoint:server.endpoint,protocolVersion:server.protocolVersion,tool:name,policy})
    const plan={connectionId,epoch:expectedEpoch,tool:name,arguments:frozen,schemaDigest:tool.schemaDigest,policyDigest,
      access:policy.access,requiresApproval:policy.requiresApproval,taskId,runId}
    plan.digest=await fingerprint(plan)
    this.assertEpoch(connectionId,expectedEpoch)
    freeze(plan)
    this.plans.add(plan)
    return plan
  }
  accept(plan,{id,commandId,taskId=plan.taskId,runId=plan.runId}={}) {
    identifier(id,'operation_id'); identifier(commandId,'command_id')
    const existing=this.rawOperation(id)
    if(existing) {check(existing.digest===plan.digest,'connector_operation_conflict',409);return connectorOperationView(existing)}
    check(this.plans.has(plan),'connector_plan_required',403)
    this.assertEpoch(plan.connectionId,plan.epoch)
    check(this.store.one("SELECT COUNT(*) count FROM connector_operations WHERE state IN ('waiting_approval','queued','dispatching','unknown')").count<this.maxOperations,'connector_operation_capacity_reached',429)
    const op={...clone(plan),id,commandId,taskId,runId,version:1,state:plan.requiresApproval?'waiting_approval':'queued',createdAt:this.now(),due:0}
    this.store.tx(()=>this.saveOperation(op))
    this.plans.delete(plan)
    return connectorOperationView(op)
  }
  rawOperation(id) { const row=this.store.one('SELECT data FROM connector_operations WHERE id=?',id);return row?JSON.parse(row.data):null }
  operation(id) { return connectorOperationView(this.rawOperation(identifier(id,'operation_id'))) }
  operationPage({before=Number.MAX_SAFE_INTEGER,limit=50,pending=false}={}) {
    check(Number.isSafeInteger(before)&&before>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'invalid_connector_page')
    const filter=pending?" AND state IN ('waiting_approval','queued','dispatching','unknown')":''
    const rows=this.store.rows('SELECT rowid n,data FROM connector_operations WHERE rowid<?'+filter+' ORDER BY rowid DESC LIMIT ?',before,limit+1)
    return {operations:rows.slice(0,limit).map(row=>connectorOperationView(JSON.parse(row.data))),nextBefore:rows.length>limit?rows[limit-1].n:null}
  }
  saveOperation(op) {
    op.updatedAt=this.now()
    this.store.rows('INSERT INTO connector_operations VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      op.id,op.state,op.due??0,op.connectionId,op.taskId??null,JSON.stringify(op))
    this.store.event('connector.operation.updated',{operation:connectorOperationView(op)})
  }
  decide({operationId,approvalVersion,approve}) {
    return this.store.tx(()=>{
      const op=this.rawOperation(operationId)
      check(op,'connector_operation_not_found',404)
      check(op.version===approvalVersion,'stale_version',409)
      check(op.state==='waiting_approval','connector_approval_closed',409)
      if(approve)this.tool(op.connectionId,op.epoch,op.tool)
      op.version++;op.state=approve?'queued':'rejected';op.approvedAt=this.now()
      this.saveOperation(op)
      if(!approve)this.onSettled(connectorOperationView(op))
      return connectorOperationView(op)
    })
  }
  cancel({operationId,approvalVersion}) {
    return this.store.tx(()=>{
      const op=this.rawOperation(operationId)
      check(op,'connector_operation_not_found',404)
      check(op.version===approvalVersion,'stale_version',409)
      check(['queued','waiting_approval'].includes(op.state),'connector_already_dispatched',409)
      return this.settle(op,{status:'cancelled',code:'cancelled_by_user'})
    })
  }
  reconcile({operationId,approvalVersion,outcome,evidence}) {
    return this.store.tx(()=>{
      const op=this.rawOperation(operationId)
      check(op,'connector_operation_not_found',404)
      check(op.version===approvalVersion && op.state==='unknown','connector_not_awaiting_reconciliation',409)
      check(['succeeded','failed'].includes(outcome),'connector_invalid_reconciliation')
      boundedString(evidence,2048,'connector_evidence_required')
      check(evidence.trim().length>0,'connector_evidence_required')
      return this.settle(op,{status:outcome,code:'user_verified',evidence,priorReceipt:op.receipt})
    })
  }
  settle(op,receipt) {
    return this.store.tx(()=>{
      // Account erasure or a newer terminal result wins over a late callback.
      const current=this.rawOperation(op.id)
      if(!current)return null
      if(finalStates.has(current.state)&&current.state!=='unknown')return connectorOperationView(current)
      current.state=receipt.status;current.receipt=receipt;current.version++
      this.saveOperation(current)
      const view=connectorOperationView(current)
      this.onSettled(view)
      return view
    })
  }
  recover() {
    this.store.tx(()=>{
      for(const {data} of this.store.rows("SELECT data FROM connector_operations WHERE state='dispatching'"))this.settle(JSON.parse(data),{status:'unknown',code:'connector_interrupted_after_dispatch'})
      for(const row of this.store.rows("SELECT id FROM connector_connections WHERE refreshing IS NOT NULL AND status='active'")) {
        this.store.rows("UPDATE connector_connections SET status='reauthorization_required',epoch=epoch+1,sealed=NULL,refreshing=NULL,updated=? WHERE id=?",this.now(),row.id)
        this.store.rows('DELETE FROM connector_tools WHERE connection=?',row.id)
        this.updated(row.id)
      }
    })
  }
  nextDue() {
    return this.store.one(`SELECT MIN(o.due) due FROM connector_operations o WHERE o.state='queued'
      AND NOT EXISTS(SELECT 1 FROM connector_operations p WHERE p.connection=o.connection AND
      (p.state IN ('dispatching','unknown') OR (p.state='queued' AND p.rowid<o.rowid)))`).due
  }
  async runNext({signal}={}) {
    const row=this.store.one(`SELECT o.id FROM connector_operations o WHERE o.state='queued' AND o.due<=?
      AND NOT EXISTS(SELECT 1 FROM connector_operations p WHERE p.connection=o.connection AND
      (p.state IN ('dispatching','unknown') OR (p.state='queued' AND p.rowid<o.rowid))) ORDER BY o.rowid LIMIT 1`,this.now())
    if(!row)return false
    await this.run(row.id,{signal})
    return true
  }
  async run(id,{signal}={}) {
    const lifecycle=this.lifecycle()
    if(this.running.has(id))return
    let op=this.rawOperation(id)
    if(!op||op.state!=='queued')return
    if(this.store.one("SELECT 1 FROM connector_operations WHERE connection=? AND id<>? AND state IN ('dispatching','unknown')",op.connectionId,id))return
    const controller=new AbortController(), combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    this.running.set(id,{connectionId:op.connectionId,controller})
    let dispatched=false, credential
    try {
      // Re-read the catalog before an approved effect. A schema change invalidates
      // the frozen approval; the caller must produce and approve a new operation.
      await this.discover({connectionId:op.connectionId,expectedEpoch:op.epoch,signal:combined})
      const {server,policy,tool}=this.tool(op.connectionId,op.epoch,op.tool)
      check(tool.schemaDigest===op.schemaDigest,'connector_tool_schema_changed',409)
      check(await fingerprint({endpoint:server.endpoint,protocolVersion:server.protocolVersion,tool:op.tool,policy})===op.policyDigest,'connector_tool_policy_changed',409)
      validateArguments(tool.inputSchema,op.arguments)
      credential=await this.credential(op.connectionId,op.epoch,{signal:combined})
      const prepared=await this.transport.prepare(server,credential,{connectionId:op.connectionId,epoch:op.epoch,signal:combined})
      await this.assertOwner({connectionId:op.connectionId,taskId:op.taskId,runId:op.runId,operationId:id,signal:combined})
      const claimed=this.store.tx(()=>{
        this.assertLifecycle(lifecycle)
        const current=this.rawOperation(id)
        check(current?.state==='queued','connector_operation_superseded',409)
        this.assertEpoch(op.connectionId,op.epoch)
        if(this.store.one(`SELECT 1 FROM connector_operations p WHERE p.connection=? AND p.id<>? AND
          (p.state IN ('dispatching','unknown') OR (p.state='queued' AND p.rowid<(SELECT rowid FROM connector_operations WHERE id=?)))`,op.connectionId,id,id))return false
        current.state='dispatching';current.version++;this.saveOperation(current);op=current
        return true
      })
      if(!claimed)return
      combined.throwIfAborted()
      dispatched=true
      const result=await this.transport.request(server,credential,'tools/call',{name:op.tool,arguments:op.arguments,
        _meta:{'io.maco/operationId':op.id}},{connectionId:op.connectionId,epoch:op.epoch,signal:combined,prepared,headers:toolHeaders(tool.inputSchema,op.arguments)})
      this.assertLifecycle(lifecycle)
      if(tool.outputSchema)validateArguments(tool.outputSchema,result.structuredContent,{objectRoot:false,maxBytes:LIMITS.responseBytes})
      const projected=resultView(result,credential.accessToken)
      this.settle(op,{status:projected.isError?(op.access==='write'?'unknown':'failed'):'succeeded',
        ...(projected.isError?{code:'connector_tool_reported_error'}:{}),result:projected})
    } catch(error) {
      const current=this.rawOperation(id)
      if(current && ['queued','dispatching'].includes(current.state)) this.settle(current,
        {status:dispatched && !error.preExecution && op.access==='write'?'unknown':'failed',code:errorCode(error,'connector_execution_failed')})
    } finally { this.running.delete(id) }
  }
  activeCount() { return this.running.size+this.refreshing.size }
  pendingStatus() {
    const counts=Object.fromEntries(this.store.rows('SELECT state,COUNT(*) count FROM connector_operations GROUP BY state').map(row=>[row.state,row.count]))
    return {active:this.activeCount(),queued:counts.queued??0,waitingApproval:counts.waiting_approval??0,
      dispatching:counts.dispatching??0,unknown:counts.unknown??0}
  }
  fence({revokeConnections=false}={}) {
    for(const entry of this.running.values())entry.controller.abort()
    return this.store.tx(()=>{
      this.store.rows('UPDATE connector_identity SET lifecycle=lifecycle+1 WHERE singleton=1')
      this.store.rows('DELETE FROM connector_oauth')
      for(const {data} of this.store.rows("SELECT data FROM connector_operations WHERE state IN ('queued','waiting_approval','dispatching')")) {
        const op=JSON.parse(data)
        this.settle(op,{status:op.state==='dispatching'?'unknown':'cancelled',code:'account_lifecycle_changed'})
      }
      if(revokeConnections)for(const {id,epoch} of this.store.rows("SELECT id,epoch FROM connector_connections WHERE status<>'revoked'"))this.revoke(id,epoch)
      return this.pendingStatus()
    })
  }
  erase() {
    for(const entry of this.running.values())entry.controller.abort()
    this.store.tx(()=>{
      this.store.rows('UPDATE connector_identity SET lifecycle=lifecycle+1 WHERE singleton=1')
      for(const table of ['connector_operations','connector_tools','connector_oauth','connector_connections'])this.store.rows('DELETE FROM '+table)
    })
    this.transport.sessions.clear()
  }
}

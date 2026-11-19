import { failure } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'
import { check, isObject, jsonBytes, LIMITS, MODERN_VERSION, PROTOCOL_VERSIONS, readBounded, safeURL } from './policy.mjs'
import { headerValue } from './schema.mjs'

// Official specification:
// https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
// This client advertises no sampling, elicitation, roots or task extensions.
const clientInfo = {name:'maco-harness',version:'0.4.0'}
function rpcValue(value,id) {
  check(isObject(value) && value.jsonrpc === '2.0','connector_invalid_response',502)
  if (typeof value.method === 'string') {
    check(value.id === undefined,'connector_server_request_unsupported',422)
    return undefined
  }
  check(value.id === id,'connector_response_id_mismatch',502)
  if (value.error !== undefined) {
    check(isObject(value.error) && Number.isInteger(value.error.code),'connector_invalid_response',502)
    const error = failure('connector_rpc_error',502)
    error.rpcCode = value.error.code
    // Never echo a remote error message: servers can reflect credentials or input.
    error.preExecution = [-32600,-32601,-32602,-32020,-32022].includes(error.rpcCode)
    throw error
  }
  check(isObject(value.result),'connector_invalid_response',502)
  return value.result
}
async function sseResult(response,id,signal) {
  check(response.body,'connector_invalid_response',502)
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true})
  let buffer='', size=0, messages=0, lines=[]
  function frame(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /,'')).join('\n')
    if (!data) return undefined
    check(++messages <= 1024,'connector_response_too_large',502)
    let value
    try { value=JSON.parse(data) } catch { throw failure('connector_invalid_response',502) }
    return rpcValue(value,id)
  }
  function consume(final=false) {
    let at
    while((at=buffer.search(/[\r\n]/))>=0) {
      if(buffer[at]==='\r' && at===buffer.length-1 && !final)break
      const line=buffer.slice(0,at),width=buffer[at]==='\r' && buffer[at+1]==='\n'?2:1
      buffer=buffer.slice(at+width)
      if(line==='') {const result=frame(lines.join('\n'));lines=[];if(result!==undefined)return result}
      else lines.push(line)
    }
    if(final) {if(buffer)lines.push(buffer);return frame(lines.join('\n'))}
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      check(size <= LIMITS.responseBytes,'connector_response_too_large',502)
      buffer += decoder.decode(value,{stream:true})
      const result=consume()
      if(result!==undefined)return result
    }
    buffer += decoder.decode()
    const result=consume(true)
    if(result!==undefined)return result
    throw failure('connector_stream_incomplete',502)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export class McpTransport {
  constructor(fetcher=fetch) { this.fetcher=fetcher; this.sessions=new Map(); this.initializing=new Map() }
  forget(connectionId) {
    for (const key of this.sessions.keys()) if (key.startsWith(connectionId+':')) this.sessions.delete(key)
  }
  async post(server,credential,message,{signal,sessionId,headers:extra={},assertAuthorized}={}) {
    const endpoint=safeURL(server.endpoint).href
    const modern=server.protocolVersion===MODERN_VERSION
    const params={...(message.params || {})}
    if (modern) params._meta={...(params._meta || {}),
      'io.modelcontextprotocol/protocolVersion':server.protocolVersion,
      'io.modelcontextprotocol/clientInfo':clientInfo,
      'io.modelcontextprotocol/clientCapabilities':{}}
    const body={...message,params}
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':server.protocolVersion,'Mcp-Method':message.method,...extra}
    if (message.method==='tools/call') headers['Mcp-Name']=headerValue(params.name)
    if (credential.accessToken) headers.Authorization='Bearer '+credential.accessToken
    if (!modern && sessionId) headers['Mcp-Session-Id']=sessionId
    return withDeadline(LIMITS.timeoutMs,signal,async deadline => {
      assertAuthorized?.()
      let response
      try { response=await this.fetcher(endpoint,{method:'POST',headers,body:jsonBytes(body,256*1024),signal:deadline,redirect:'manual'}) }
      catch { throw failure(deadline.aborted?'connector_request_aborted':'connector_transport_error',502) }
      if (!response.ok) {
        if([400,404,500].includes(response.status) && response.headers.get('content-type')?.startsWith('application/json')) {
          let value
          try {value=JSON.parse(await readBounded(response,LIMITS.metadataBytes))} catch {}
          if(value?.jsonrpc==='2.0' && value.id===message.id && isObject(value.error))rpcValue(value,message.id)
        }
        await response.body?.cancel().catch(() => {})
        const code=response.status===401?'connector_reauthorization_required':response.status===403?'connector_scope_required':
          response.status===429?'connector_rate_limited':response.status>=300&&response.status<400?'connector_redirect_forbidden':'connector_http_error'
        const error=failure(code,response.status===401||response.status===403?403:502)
        error.httpStatus=response.status
        error.preExecution=[401,403,429].includes(response.status)
        throw error
      }
      let nextSession
      if (!modern && response.headers.has('mcp-session-id')) {
        nextSession=response.headers.get('mcp-session-id')
        check(/^[\x21-\x7e]{1,256}$/.test(nextSession),'connector_invalid_session',502)
      }
      if (message.id === undefined) {
        await response.body?.cancel().catch(() => {})
        check(response.status===202||response.status===204,'connector_notification_rejected',502)
        return {sessionId:nextSession}
      }
      const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      let result
      if (type==='text/event-stream') result=await sseResult(response,message.id,deadline)
      else {
        check(type==='application/json','connector_invalid_content_type',502)
        let value
        try { value=JSON.parse(await readBounded(response)) } catch (error) {
          if (error.code) throw error
          throw failure('connector_invalid_response',502)
        }
        result=rpcValue(value,message.id)
      }
      return {result,sessionId:nextSession}
    })
  }
  async prepare(server,credential,{connectionId,epoch,signal,assertAuthorized}={}) {
    assertAuthorized?.()
    if (server.protocolVersion===MODERN_VERSION) return {version:MODERN_VERSION}
    const key=connectionId+':'+epoch
    if (this.sessions.has(key)) return this.sessions.get(key)
    let flight=this.initializing.get(key)
    if (!flight) {
      flight=(async () => {
        const init=await this.post(server,credential,{jsonrpc:'2.0',id:crypto.randomUUID(),method:'initialize',
          params:{protocolVersion:server.protocolVersion,capabilities:{},clientInfo}},{signal,assertAuthorized})
        check(PROTOCOL_VERSIONS.has(init.result.protocolVersion) && init.result.protocolVersion!==MODERN_VERSION,'connector_protocol_mismatch',502)
        check(isObject(init.result.capabilities) && isObject(init.result.capabilities.tools),'connector_tools_unsupported',422)
        const negotiated={...server,protocolVersion:init.result.protocolVersion}
        await this.post(negotiated,credential,{jsonrpc:'2.0',method:'notifications/initialized'},{signal,sessionId:init.sessionId,assertAuthorized})
        assertAuthorized?.()
        const state={version:init.result.protocolVersion,sessionId:init.sessionId}
        this.sessions.set(key,state)
        return state
      })().finally(() => this.initializing.delete(key))
      this.initializing.set(key,flight)
    }
    return flight
  }
  async request(server,credential,method,params,{connectionId,epoch,signal,headers,prepared,assertAuthorized}={}) {
    const state=prepared ?? await this.prepare(server,credential,{connectionId,epoch,signal,assertAuthorized})
    const result=await this.post({...server,protocolVersion:state.version},credential,
      {jsonrpc:'2.0',id:crypto.randomUUID(),method,params},{signal,headers,sessionId:state.sessionId,assertAuthorized})
    assertAuthorized?.()
    if (state.version===MODERN_VERSION) {
      check(result.result.resultType!=='input_required','connector_interaction_unsupported',422)
      check(result.result.resultType==='complete','connector_invalid_result_type',502)
    }
    return result.result
  }
}

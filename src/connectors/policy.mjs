import { failure } from '../connections/crypto.mjs'

export const MODERN_VERSION = '2026-07-28'
export const PROTOCOL_VERSIONS = new Set([MODERN_VERSION,'2025-11-25','2025-06-18','2025-03-26'])
export const LIMITS = {responseBytes:1024*1024, metadataBytes:128*1024, schemaBytes:64*1024,
  argumentsBytes:64*1024, catalogBytes:512*1024, tools:128, pages:8, timeoutMs:25000, oauthMs:15000}
const blockedHosts = new Set(['gmail.googleapis.com','www.googleapis.com','graph.microsoft.com','outlook.office.com','outlook.office365.com'])
const forbiddenKeys = new Set(['__proto__','prototype','constructor'])
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function check(condition,code='invalid_connector_configuration',status=400) {
  if (!condition) throw failure(code,status)
}
export function boundedString(value,max,code='invalid_connector_input') {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value),code)
  return value
}
export function safeURL(value) {
  let url
  try { url = new URL(value) } catch { throw failure('connector_url_forbidden',403) }
  const host = url.hostname.toLowerCase()
  // Only administrator-listed DNS names are used. IP literals, local names,
  // credentials, alternate ports and redirects never receive bearer tokens.
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
    (!url.port || url.port === '443') && host.includes('.') && !host.endsWith('.') &&
    !host.includes(':') && !/^\d+(?:\.\d+){3}$/.test(host) &&
    !/(?:^|\.)(?:localhost|local|internal|localdomain|test|invalid)$/.test(host) &&
    !blockedHosts.has(host),'connector_url_forbidden',403)
  return url
}
export function exactURL(value,allowed) {
  const url = safeURL(value).href
  check(Array.isArray(allowed) && allowed.some(entry => safeURL(entry).href === url),'connector_endpoint_forbidden',403)
  return url
}
export function jsonBytes(value,max,code='connector_input_too_large') {
  let serialized
  try { serialized = JSON.stringify(value) } catch { throw failure('invalid_connector_json') }
  check(typeof serialized === 'string' && new TextEncoder().encode(serialized).byteLength <= max,code,413)
  return serialized
}
export function secretString(value,code='invalid_connector_token') {
  check(typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value),code)
  return value
}
export function loadServers(env) {
  let raw
  try { raw = typeof env.MCP_SERVERS === 'string' ? JSON.parse(env.MCP_SERVERS) : env.MCP_SERVERS ?? {} }
  catch { throw failure('invalid_connector_configuration',503) }
  check(isObject(raw),'invalid_connector_configuration',503)
  check(Object.keys(raw).length <= 64,'invalid_connector_configuration',503)
  const servers = new Map()
  for (const [id,value] of Object.entries(raw)) {
    check(/^[a-zA-Z0-9_-]{1,64}$/.test(id) && !forbiddenKeys.has(id) && isObject(value),'invalid_connector_configuration',503)
    const endpoint = safeURL(value.endpoint).href
    const protocolVersion = value.protocolVersion ?? MODERN_VERSION
    check(PROTOCOL_VERSIONS.has(protocolVersion),'unsupported_connector_protocol',503)
    check(isObject(value.tools ?? {}),'invalid_connector_configuration',503)
    const tools = new Map()
    for (const [name,policy] of Object.entries(value.tools ?? {})) {
      check(/^[A-Za-z0-9_.-]{1,128}$/.test(name) && !forbiddenKeys.has(name) && isObject(policy),'invalid_connector_tool_policy',503)
      // This declaration is administrator-owned, not taken from tool names,
      // descriptions or MCP annotations. Unknown tools are never executable.
      check(['read','write'].includes(policy.access) && policy.mailWrite === false,'connector_mail_bypass_forbidden',403)
      const approval = policy.approval ?? 'always'
      check(['always','never'].includes(approval) && !(policy.access === 'write' && approval === 'never'),'invalid_connector_tool_policy',503)
      tools.set(name,{access:policy.access,requiresApproval:approval !== 'never',mailWrite:false})
    }
    const oauth = value.oauth
    if (oauth !== undefined) {
      check(isObject(oauth),'invalid_connector_oauth_configuration',503)
      safeURL(oauth.issuer)
      safeURL(oauth.resourceMetadataUrl)
      check(Array.isArray(oauth.metadataUrls) && oauth.metadataUrls.length >= 1 && oauth.metadataUrls.length <= 4,'invalid_connector_oauth_configuration',503)
      oauth.metadataUrls.forEach(safeURL)
      check(Array.isArray(oauth.allowedEndpoints) && oauth.allowedEndpoints.length >= 2 && oauth.allowedEndpoints.length <= 16,'invalid_connector_oauth_configuration',503)
      oauth.allowedEndpoints.forEach(safeURL)
      if (oauth.resource) safeURL(oauth.resource)
      if (oauth.clientMetadataUrl) safeURL(oauth.clientMetadataUrl)
      for (const name of [oauth.clientIdEnv,oauth.clientSecretEnv]) {
        check(name===undefined || typeof name==='string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
          !forbiddenKeys.has(name),'invalid_connector_oauth_configuration',503)
      }
      check(oauth.scopes === undefined || (Array.isArray(oauth.scopes) && oauth.scopes.length <= 64 && oauth.scopes.every(s => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s))),'invalid_connector_oauth_configuration',503)
    }
    servers.set(id,{id,endpoint,protocolVersion,tools,oauth,allowAnonymous:value.allowAnonymous === true,
      label:typeof value.label === 'string' ? value.label.slice(0,120) : id})
  }
  return servers
}
export async function readBounded(response,max=LIMITS.responseBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {})
    throw failure('connector_response_too_large',502)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8',{fatal:true})
  let size = 0, result = ''
  try {
    while (true) {
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      check(size <= max,'connector_response_too_large',502)
      result += decoder.decode(value,{stream:true})
    }
    return result + decoder.decode()
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

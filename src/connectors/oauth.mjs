import { challenge, failure, nonce } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'
import { hasSecret, readSecret } from '../secrets.mjs'
import { check, exactURL, isObject, LIMITS, readBounded, safeURL, secretString } from './policy.mjs'

// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
// Discovery endpoints and the authorization server are explicitly configured by
// the operator. An MCP response cannot redirect credentials to another issuer.
async function requestJSON(url,options,fetcher,signal,assertAuthorized,onDispatch) {
  return withDeadline(LIMITS.oauthMs,signal,async deadline => {
    const address=safeURL(url).href
    assertAuthorized?.()
    onDispatch?.()
    let response
    try { response=await fetcher(address,{...options,redirect:'manual',signal:deadline}) }
    catch { throw failure('connector_oauth_unavailable',503) }
    try {assertAuthorized?.()} catch(error) {await response.body?.cancel().catch(()=>{});throw error}
    if (response.status>=300 && response.status<400) {
      await response.body?.cancel().catch(() => {})
      throw failure('connector_redirect_forbidden',403)
    }
    let body
    try { body=JSON.parse(await readBounded(response,LIMITS.metadataBytes)) }
    catch (error) {
      if(error.code)throw error
      const invalid=failure('connector_oauth_invalid_response',502)
      if(!response.ok)invalid.httpStatus=response.status
      throw invalid
    }
    if (!response.ok) {
      const error=failure(body?.error==='invalid_grant'?'connector_reauthorization_required':'connector_oauth_unavailable',body?.error==='invalid_grant'?403:503)
      error.httpStatus=response.status
      throw error
    }
    check(isObject(body),'connector_oauth_invalid_response',502)
    return body
  })
}
function clientAuth(client,body) {
  const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'}
  if (client.authMethod==='client_secret_basic') {
    headers.Authorization='Basic '+btoa(encodeURIComponent(client.id)+':'+encodeURIComponent(client.secret))
  } else {
    body.set('client_id',client.id)
    if (client.authMethod==='client_secret_post') body.set('client_secret',client.secret)
  }
  return headers
}
function configuredClient(policy,env) {
  const id=policy.clientIdEnv ? env[policy.clientIdEnv] : policy.clientId
  if (!id) return null
  const authMethod=policy.tokenEndpointAuthMethod ?? (policy.clientSecretEnv?'client_secret_post':'none')
  check(['none','client_secret_post','client_secret_basic'].includes(authMethod) &&
    (authMethod==='none'||hasSecret(env[policy.clientSecretEnv])),'connector_oauth_client_invalid',503)
  // Persist only the operator's reference. Even a direct Worker secret must be
  // read again at exchange/refresh, not copied into every user's OAuth grant.
  return {id:secretString(id,'connector_oauth_client_invalid'),authMethod,source:'configured',
    ...(authMethod!=='none'?{secretEnv:policy.clientSecretEnv}:{})}
}
async function resolveClient(server,stored,env,{signal,assertAuthorized}={}) {
  const policy=server.oauth
  const configuredId=policy.clientIdEnv ? env[policy.clientIdEnv] : policy.clientId
  const metadataId=policy.clientMetadataUrl ? safeURL(policy.clientMetadataUrl).href : undefined
  let client=stored
  if (stored.source==='configured' || stored.secretEnv || (!stored.source && configuredId)) {
    // Legacy grants did not record the client source. A matching operator
    // client ID is required before replacing their embedded secret with a ref.
    const configured=configuredClient(policy,env)
    check(configured && configured.id===stored.id && configured.authMethod===stored.authMethod,
      'connector_reauthorization_required',403)
    client=configured
  } else if (stored.source==='metadata' || (!stored.source && stored.id===metadataId)) {
    check(stored.id===metadataId && stored.authMethod==='none','connector_reauthorization_required',403)
    client={id:stored.id,authMethod:'none',source:'metadata'}
  } else {
    check((stored.source===undefined || stored.source==='dynamic') && policy.allowDynamicRegistration===true,
      'connector_reauthorization_required',403)
    client={...stored,source:'dynamic'}
  }
  let requestClient=client
  if (client.secretEnv) {
    const secret=await readSecret(env[client.secretEnv],{signal,code:'connector_oauth_client_secret_unavailable',maxBytes:16384})
    assertAuthorized?.()
    check(/^[\x21-\x7e]{1,16384}$/.test(secret),'connector_oauth_client_invalid',503)
    requestClient={...client,secret}
  }
  return {client,requestClient}
}
export function checkIssuer(flow,iss) {
  check((iss===undefined && !flow.requireIssuer) || iss===flow.issuer,'connector_oauth_issuer_mismatch',403)
}
export async function beginAuthorization(server,env,fetcher,{signal,assertAuthorized}={}) {
  const policy=server.oauth
  check(policy,'connector_oauth_not_configured',503)
  safeURL(policy.issuer)
  const resource=safeURL(policy.resource ?? server.endpoint).href
  const prm=await requestJSON(policy.resourceMetadataUrl,{headers:{Accept:'application/json'}},fetcher,signal,assertAuthorized)
  check(prm.resource===resource && Array.isArray(prm.authorization_servers) && prm.authorization_servers.includes(policy.issuer),'connector_oauth_resource_mismatch',403)
  let metadata
  for (const address of policy.metadataUrls) {
    try { metadata=await requestJSON(address,{headers:{Accept:'application/json'}},fetcher,signal,assertAuthorized); break }
    catch (error) { if (error.httpStatus!==404) throw error }
  }
  check(metadata && metadata.issuer===policy.issuer,'connector_oauth_issuer_mismatch',403)
  check(metadata.code_challenge_methods_supported?.includes('S256'),'connector_oauth_pkce_unsupported',422)
  check(!metadata.response_types_supported || metadata.response_types_supported.includes('code'),'connector_oauth_flow_unsupported',422)
  const authorizationEndpoint=exactURL(metadata.authorization_endpoint,policy.allowedEndpoints)
  const tokenEndpoint=exactURL(metadata.token_endpoint,policy.allowedEndpoints)
  const redirectUri=safeURL(env.MCP_OAUTH_REDIRECT_URI ?? env.OAUTH_REDIRECT_URI).href
  let client=configuredClient(policy,env)
  if (!client && policy.clientMetadataUrl && metadata.client_id_metadata_document_supported===true) {
    client={id:safeURL(policy.clientMetadataUrl).href,authMethod:'none',source:'metadata'}
  } else if (!client) {
    check(policy.allowDynamicRegistration===true && metadata.registration_endpoint,'connector_oauth_client_required',503)
    const registrationEndpoint=exactURL(metadata.registration_endpoint,policy.allowedEndpoints)
    const registration=await requestJSON(registrationEndpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({client_name:'Maco',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],
        response_types:['code'],token_endpoint_auth_method:'none',application_type:'web'})},fetcher,signal,assertAuthorized)
    check(!registration.redirect_uris || registration.redirect_uris.includes(redirectUri),'connector_oauth_registration_invalid',502)
    const authMethod=registration.token_endpoint_auth_method ?? 'none'
    check(['none','client_secret_post','client_secret_basic'].includes(authMethod),'connector_oauth_registration_invalid',502)
    client={id:secretString(registration.client_id,'connector_oauth_registration_invalid'),authMethod,source:'dynamic'}
    if (authMethod!=='none') client.secret=secretString(registration.client_secret,'connector_oauth_registration_invalid')
  }
  if (metadata.token_endpoint_auth_methods_supported) check(metadata.token_endpoint_auth_methods_supported.includes(client.authMethod),'connector_oauth_client_auth_unsupported',422)
  const scopes=policy.scopes ?? (Array.isArray(prm.scopes_supported)?prm.scopes_supported:[])
  check(scopes.length<=64 && scopes.every(s => typeof s==='string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s)),'connector_oauth_invalid_scopes',422)
  const state=nonce(), verifier=nonce()
  const url=new URL(authorizationEndpoint)
  for (const [key,value] of Object.entries({response_type:'code',client_id:client.id,redirect_uri:redirectUri,
    code_challenge:await challenge(verifier),code_challenge_method:'S256',state,resource})) url.searchParams.set(key,value)
  if (scopes.length) url.searchParams.set('scope',scopes.join(' '))
  return {state,authorizationUrl:url.href,flow:{issuer:policy.issuer,resource,redirectUri,client,scopes,tokenEndpoint,
    verifier,requireIssuer:metadata.authorization_response_iss_parameter_supported===true}}
}
function grant(data,previous,flow,now) {
  check(String(data.token_type).toLowerCase()==='bearer','connector_oauth_invalid_token',502)
  const accessToken=secretString(data.access_token,'connector_oauth_invalid_token')
  const refreshToken=data.refresh_token ?? previous?.refreshToken
  if (refreshToken!==undefined) secretString(refreshToken,'connector_oauth_invalid_token')
  const lifetime=data.expires_in ?? 300
  check(Number.isSafeInteger(lifetime) && lifetime>0 && lifetime<=365*86400,'connector_oauth_invalid_expiry',502)
  check(data.scope===undefined || typeof data.scope==='string','connector_oauth_invalid_scopes',502)
  const scopes=data.scope===undefined ? previous?.scopes ?? flow.scopes : data.scope.trim().split(/\s+/).filter(Boolean)
  check(scopes.length<=128,'connector_oauth_invalid_scopes',502)
  return {kind:'oauth',accessToken,...(refreshToken?{refreshToken}:{}),expiresAt:now+1000*lifetime,scopes:[...new Set(scopes)].sort(),
    oauth:{issuer:flow.issuer,resource:flow.resource,client:flow.client,tokenEndpoint:flow.tokenEndpoint}}
}
export async function redeemAuthorization(server,flow,code,fetcher,{env={},signal,now=Date.now(),assertAuthorized,onDispatch}={}) {
  check(flow.issuer===server.oauth?.issuer,'connector_oauth_issuer_mismatch',403)
  check(flow.resource===safeURL(server.oauth.resource ?? server.endpoint).href,'connector_oauth_resource_mismatch',403)
  const endpoint=exactURL(flow.tokenEndpoint,server.oauth.allowedEndpoints)
  const {client,requestClient}=await resolveClient(server,flow.client,env,{signal,assertAuthorized})
  const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:flow.redirectUri,code_verifier:flow.verifier,resource:flow.resource})
  const data=await requestJSON(endpoint,{method:'POST',headers:clientAuth(requestClient,body),body},fetcher,signal,assertAuthorized,onDispatch)
  return grant(data,null,{...flow,client},now)
}
export async function refreshAuthorization(server,previous,fetcher,{env={},signal,now=Date.now(),assertAuthorized,onDispatch}={}) {
  check(previous.refreshToken,'connector_reauthorization_required',403)
  const flow=previous.oauth
  check(flow?.issuer===server.oauth?.issuer,'connector_oauth_issuer_mismatch',403)
  check(flow.resource===safeURL(server.oauth.resource ?? server.endpoint).href,'connector_oauth_resource_mismatch',403)
  const endpoint=exactURL(flow.tokenEndpoint,server.oauth.allowedEndpoints)
  const {client,requestClient}=await resolveClient(server,flow.client,env,{signal,assertAuthorized})
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:previous.refreshToken,resource:flow.resource})
  const data=await requestJSON(endpoint,{method:'POST',headers:clientAuth(requestClient,body),body},fetcher,signal,assertAuthorized,onDispatch)
  return grant(data,previous,{...flow,client},now)
}

import { challenge, failure, nonce } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'
import { check, exactURL, isObject, LIMITS, readBounded, safeURL, secretString } from './policy.mjs'

// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
// Discovery endpoints and the authorization server are explicitly configured by
// the operator. An MCP response cannot redirect credentials to another issuer.
async function requestJSON(url,options,fetcher,signal,assertAuthorized) {
  return withDeadline(LIMITS.oauthMs,signal,async deadline => {
    assertAuthorized?.()
    let response
    try { response=await fetcher(safeURL(url).href,{...options,redirect:'manual',signal:deadline}) }
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
  let client
  const configuredId=policy.clientIdEnv ? env[policy.clientIdEnv] : policy.clientId
  if (configuredId) {
    const secret=policy.clientSecretEnv ? env[policy.clientSecretEnv] : undefined
    const authMethod=policy.tokenEndpointAuthMethod ?? (secret?'client_secret_post':'none')
    check(['none','client_secret_post','client_secret_basic'].includes(authMethod) && (authMethod==='none'||secret),'connector_oauth_client_invalid',503)
    client={id:secretString(configuredId,'connector_oauth_client_invalid'),authMethod,...(secret?{secret:secretString(secret)}:{})}
  } else if (policy.clientMetadataUrl && metadata.client_id_metadata_document_supported===true) {
    client={id:safeURL(policy.clientMetadataUrl).href,authMethod:'none'}
  } else {
    check(policy.allowDynamicRegistration===true && metadata.registration_endpoint,'connector_oauth_client_required',503)
    const registrationEndpoint=exactURL(metadata.registration_endpoint,policy.allowedEndpoints)
    const registration=await requestJSON(registrationEndpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({client_name:'Maco',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],
        response_types:['code'],token_endpoint_auth_method:'none',application_type:'web'})},fetcher,signal,assertAuthorized)
    check(!registration.redirect_uris || registration.redirect_uris.includes(redirectUri),'connector_oauth_registration_invalid',502)
    const authMethod=registration.token_endpoint_auth_method ?? 'none'
    check(['none','client_secret_post','client_secret_basic'].includes(authMethod),'connector_oauth_registration_invalid',502)
    client={id:secretString(registration.client_id,'connector_oauth_registration_invalid'),authMethod}
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
export async function redeemAuthorization(server,flow,code,fetcher,{signal,now=Date.now(),assertAuthorized}={}) {
  check(flow.issuer===server.oauth?.issuer,'connector_oauth_issuer_mismatch',403)
  const endpoint=exactURL(flow.tokenEndpoint,server.oauth.allowedEndpoints)
  const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:flow.redirectUri,code_verifier:flow.verifier,resource:flow.resource})
  const data=await requestJSON(endpoint,{method:'POST',headers:clientAuth(flow.client,body),body},fetcher,signal,assertAuthorized)
  return grant(data,null,flow,now)
}
export async function refreshAuthorization(server,previous,fetcher,{signal,now=Date.now(),assertAuthorized}={}) {
  check(previous.refreshToken,'connector_reauthorization_required',403)
  const flow=previous.oauth
  check(flow?.issuer===server.oauth?.issuer,'connector_oauth_issuer_mismatch',403)
  const endpoint=exactURL(flow.tokenEndpoint,server.oauth.allowedEndpoints)
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:previous.refreshToken,resource:flow.resource})
  const data=await requestJSON(endpoint,{method:'POST',headers:clientAuth(flow.client,body),body},fetcher,signal,assertAuthorized)
  return grant(data,previous,flow,now)
}

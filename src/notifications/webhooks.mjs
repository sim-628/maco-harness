import { failure } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'
import { boundedJSON, check, digest, email, fromBase64, key, object, sameHash } from './common.mjs'

const jwksCaches=new WeakMap()
const GOOGLE_JWKS='https://www.googleapis.com/oauth2/v3/certs'
function decode(segment) {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fromBase64(segment,16384)))}
async function googleKey(kid,fetcher,now) {
  let cache=jwksCaches.get(fetcher)
  if(!cache) {cache={at:-Infinity,keys:new Map()};jwksCaches.set(fetcher,cache)}
  if(!cache.keys.has(kid)&&now-cache.at<30000)throw failure('notification_push_unauthorized',401)
  if(now-cache.at>300000||!cache.keys.has(kid)) {
    cache.pending??=withDeadline(8000,null,async signal=>{
      let response
      try {response=await fetcher(GOOGLE_JWKS,{redirect:'manual',signal,headers:{Accept:'application/json'}})}
      catch {throw failure('notification_push_verification_unavailable',503)}
      if(!response.ok) {await response.body?.cancel().catch(()=>{});throw failure('notification_push_verification_unavailable',503)}
      const data=await boundedJSON(response,65536)
      check(Array.isArray(data.keys)&&data.keys.length<=32,'notification_push_verification_unavailable',503)
      const keys=new Map()
      for(const jwk of data.keys)if(jwk.kty==='RSA'&&typeof jwk.kid==='string'&&!jwk.d&&(!jwk.alg||jwk.alg==='RS256')&&(!jwk.use||jwk.use==='sig')) {
        keys.set(jwk.kid,await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']))
      }
      cache.keys=keys;cache.at=now
    }).finally(()=>{cache.pending=null})
    await cache.pending
  }
  check(cache.keys.has(kid),'notification_push_unauthorized',401)
  return cache.keys.get(kid)
}
// https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
export async function verifyGmailPush(request,env,{fetcher=fetch,now=Date.now}={}) {
  check(request.method==='POST','method_not_allowed',405)
  check(typeof env.GMAIL_PUBSUB_AUDIENCE==='string'&&typeof env.GMAIL_PUBSUB_SERVICE_ACCOUNT==='string'&&
    typeof env.GMAIL_PUBSUB_SUBSCRIPTION==='string','gmail_push_not_configured',503)
  const token=/^Bearer ([A-Za-z0-9._-]{1,16000})$/i.exec(request.headers.get('Authorization')||'')?.[1]
  check(token,'notification_push_unauthorized',401)
  try {
    const parts=token.split('.');check(parts.length===3,'notification_push_unauthorized',401)
    const header=decode(parts[0]),claims=decode(parts[1]),seconds=Math.floor(now()/1000)
    check(header.alg==='RS256'&&typeof header.kid==='string'&&header.crit===undefined&&
      ['https://accounts.google.com','accounts.google.com'].includes(claims.iss)&&claims.aud===env.GMAIL_PUBSUB_AUDIENCE&&
      claims.email===env.GMAIL_PUBSUB_SERVICE_ACCOUNT&&claims.email_verified===true&&typeof claims.sub==='string'&&claims.sub.length>0&&
      Number.isFinite(claims.exp)&&claims.exp>seconds&&Number.isFinite(claims.iat)&&claims.iat<=seconds+60&&
      (claims.nbf===undefined||Number.isFinite(claims.nbf)&&claims.nbf<=seconds+30),'notification_push_unauthorized',401)
    const signingKey=await googleKey(header.kid,fetcher,now())
    check(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',signingKey,fromBase64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])),
      'notification_push_unauthorized',401)
  } catch(error) {if(error.status===503)throw error;throw failure('notification_push_unauthorized',401)}
  const body=await boundedJSON(request)
  check(body.subscription===env.GMAIL_PUBSUB_SUBSCRIPTION&&object(body.message),'invalid_gmail_push')
  const messageId=key(body.message.messageId,'message_id')
  let data
  try {data=decode(body.message.data)} catch {throw failure('invalid_gmail_push')}
  check(object(data)&&typeof data.historyId==='string'&&/^\d{1,64}$/.test(data.historyId),'invalid_gmail_push')
  return {provider:'gmail',email:email(data.emailAddress),messageId,historyId:data.historyId}
}
// Microsoft requires an immediate plain-text response during subscription setup.
export function graphValidationResponse(request) {
  const token=new URL(request.url).searchParams.get('validationToken')
  if(token===null)return null
  check(request.method==='POST'&&token.length>0&&token.length<=4096&&!token.includes('\0'),'invalid_graph_validation')
  return new Response(token,{status:200,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}})
}
export async function parseGraphPush(request,{now=Date.now}={}) {
  check(request.method==='POST','method_not_allowed',405)
  const body=await boundedJSON(request)
  check(Array.isArray(body.value)&&body.value.length>=1&&body.value.length<=100,'invalid_graph_push')
  const items=[]
  for(const value of body.value) {
    check(object(value),'invalid_graph_push')
    const subscriptionId=key(value.subscriptionId,'subscription_id')
    check(typeof value.clientState==='string'&&value.clientState.length>=16&&value.clientState.length<=128,'invalid_graph_client_state',401)
    const lifecycleEvent=value.lifecycleEvent
    check(lifecycleEvent===undefined||['reauthorizationRequired','subscriptionRemoved','missed'].includes(lifecycleEvent),'invalid_graph_lifecycle')
    check(lifecycleEvent!==undefined||['created','updated','deleted'].includes(value.changeType),'invalid_graph_change_type')
    check(lifecycleEvent&&value.resource===undefined||typeof value.resource==='string'&&value.resource.length<=4096,'invalid_graph_resource')
    const version=value.resourceData?.['@odata.etag']
    const identity=JSON.stringify({subscriptionId,lifecycleEvent,changeType:value.changeType,resource:value.resource,
      id:value.id,version,...(!version&&!value.id?{minute:Math.floor(now()/60000)}:{})})
    items.push({provider:'outlook',subscriptionId,clientState:value.clientState,messageId:await digest(identity),
      ...(lifecycleEvent?{lifecycleEvent}:{}),changeType:value.changeType})
  }
  return items
}
export async function verifyGraphItem(item,route) {
  return item?.provider==='outlook'&&route?.provider==='outlook'&&item.subscriptionId===route.subscriptionId&&
    sameHash(await digest(item.clientState||''),route.clientStateHash)
}

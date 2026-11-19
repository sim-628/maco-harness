import { failure, toBase64Url } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'

export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
export function check(value,code='invalid_notification_input',status=400) {if(!value)throw failure(code,status)}
export function ownerId(value) {check(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'invalid_notification_owner');return value}
export function key(value,name='id') {check(typeof value==='string'&&/^[A-Za-z0-9_.:@-]{1,256}$/.test(value),'invalid_notification_'+name);return value}
export function email(value) {
  check(typeof value==='string'&&value.length<=320&&/^[^@\s\x00-\x1f]+@[^@\s\x00-\x1f]+\.[^@\s\x00-\x1f]+$/.test(value),'invalid_notification_email')
  return value.toLowerCase()
}
export function publicURL(value) {
  let url
  try {url=new URL(value)} catch {throw failure('invalid_notification_url')}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&
    url.hostname.includes('.')&&!url.hostname.includes(':')&&!/^\d+(?:\.\d+){3}$/.test(url.hostname)&&
    !/(?:^|\.)(localhost|local|internal|invalid)$/.test(url.hostname),'invalid_notification_url')
  return url
}
export async function digest(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('')
}
export function sameHash(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false
  let diff=0;for(let i=0;i<64;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i)
  return diff===0
}
export function b64JSON(value) {return toBase64Url(new TextEncoder().encode(JSON.stringify(value)))}
export function fromBase64(value,max=65536) {
  check(typeof value==='string'&&value.length<=Math.ceil(max*4/3)+4&&/^[A-Za-z0-9+/_-]*={0,2}$/.test(value),'invalid_notification_encoding')
  try {
    const result=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
    check(result.length<=max,'notification_body_too_large',413)
    return result
  } catch(error) {if(error.code)throw error;throw failure('invalid_notification_encoding')}
}
export async function boundedText(response,max=262144) {
  if(Number(response.headers.get('content-length'))>max) {await response.body?.cancel().catch(()=>{});throw failure('notification_body_too_large',413)}
  if(!response.body)return ''
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true})
  let count=0,text=''
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break
      count+=value.byteLength;check(count<=max,'notification_body_too_large',413)
      text+=decoder.decode(value,{stream:true})
    }
    return text+decoder.decode()
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock()}
}
export async function boundedJSON(response,max) {
  let value
  try {value=JSON.parse(await boundedText(response,max))} catch(error) {if(error.code)throw error;throw failure('invalid_notification_json')}
  check(object(value),'invalid_notification_json')
  return value
}
export async function providerJSON(url,accessToken,{fetcher=fetch,method='GET',body,signal}={}) {
  // All destinations are selected by the adapters, never by webhook input.
  const parsed=new URL(url)
  check(['gmail.googleapis.com','graph.microsoft.com'].includes(parsed.hostname)&&parsed.protocol==='https:','notification_provider_forbidden',403)
  return withDeadline(15000,signal,async deadline=>{
    let response
    try {response=await fetcher(parsed.href,{method,redirect:'manual',signal:deadline,headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})})}
    catch {const error=failure('notification_provider_unavailable',503);error.ambiguous=method!=='GET';throw error}
    if(!response.ok) {
      await response.body?.cancel().catch(()=>{})
      const error=failure(response.status===401||response.status===403?'notification_reauthorization_required':'notification_provider_error',response.status===401||response.status===403?403:503)
      error.httpStatus=response.status;error.ambiguous=method!=='GET'&&(response.status===408||response.status>=500)
      throw error
    }
    if(response.status===204) {await response.body?.cancel().catch(()=>{});return {}}
    return boundedJSON(response,262144)
  })
}

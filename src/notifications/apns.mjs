import { failure, toBase64Url, VaultCipher } from '../connections/crypto.mjs'
import { withDeadline } from '../deadline.mjs'
import { b64JSON, boundedJSON, check, digest } from './common.mjs'

export function apnsConfiguration(env) {
  const enabled=!!(env.APNS_TEAM_ID&&env.APNS_KEY_ID&&env.APNS_PRIVATE_KEY&&env.APNS_TOPIC)
  if(!enabled)return {enabled:false}
  check(/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID)&&/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID),'apns_configuration_invalid',503)
  check(/^[A-Za-z0-9.-]{3,256}$/.test(env.APNS_TOPIC),'apns_configuration_invalid',503)
  const environment=env.APNS_ENVIRONMENT??'production'
  check(['production','sandbox'].includes(environment),'apns_configuration_invalid',503)
  return {enabled:true,teamId:env.APNS_TEAM_ID,keyId:env.APNS_KEY_ID,privateKey:env.APNS_PRIVATE_KEY,topic:env.APNS_TOPIC,environment}
}
// The shared notification registry caches this sealed JWT across all account
// DOs. Apple permits reuse and asks providers to rotate it every 20–60 minutes.
export class APNsTokenProvider {
  constructor(storage,env,{now=Date.now}={}) {
    Object.assign(this,{storage,env,now});this.pending=null
    storage.transactionSync(()=>{
      storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_signer_identity (id INTEGER PRIMARY KEY,binding TEXT NOT NULL)')
      storage.sql.exec('INSERT OR IGNORE INTO notification_signer_identity VALUES (1,?)',crypto.randomUUID())
      storage.sql.exec('CREATE TABLE IF NOT EXISTS notification_signer_tokens (id INTEGER PRIMARY KEY,config TEXT NOT NULL,issued INTEGER NOT NULL,sealed TEXT NOT NULL)')
    })
    this.cipher=new VaultCipher(env.NOTIFICATION_ENCRYPTION_KEY??env.CONNECTION_ENCRYPTION_KEY,
      storage.sql.exec('SELECT binding FROM notification_signer_identity WHERE id=1').toArray()[0].binding)
  }
  async token() {
    if(this.pending)return this.pending
    this.pending=this.issue().finally(()=>{this.pending=null})
    return this.pending
  }
  async issue() {
    const cfg=apnsConfiguration(this.env)
    check(cfg.enabled,'apns_not_configured',503)
    const config=await digest(JSON.stringify([cfg.teamId,cfg.keyId,cfg.privateKey,cfg.environment]))
    const prior=this.storage.sql.exec('SELECT * FROM notification_signer_tokens WHERE id=1').toArray()[0]
    if(prior?.config===config&&this.now()-prior.issued<45*60000&&prior.issued<=this.now()+30000) {
      const secret=await this.cipher.open(['apns',config],prior.sealed)
      return {token:secret.token,expiresAt:prior.issued+3600000}
    }
    let privateKey
    try {
      const pem=cfg.privateKey.replace(/\\n/g,'\n')
      check(/^\s*-----BEGIN PRIVATE KEY-----[\s\S]*-----END PRIVATE KEY-----\s*$/.test(pem),'apns_key_invalid',503)
      const raw=Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'')),c=>c.charCodeAt(0))
      privateKey=await crypto.subtle.importKey('pkcs8',raw,{name:'ECDSA',namedCurve:'P-256'},false,['sign'])
    } catch {throw failure('apns_key_invalid',503)}
    const issued=this.now(),signing=b64JSON({alg:'ES256',kid:cfg.keyId})+'.'+b64JSON({iss:cfg.teamId,iat:Math.floor(issued/1000)})
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},privateKey,new TextEncoder().encode(signing))
    const token=signing+'.'+toBase64Url(signature)
    const sealed=await this.cipher.seal(['apns',config],{token})
    this.storage.transactionSync(()=>this.storage.sql.exec('INSERT INTO notification_signer_tokens VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,issued=excluded.issued,sealed=excluded.sealed',config,issued,sealed))
    return {token,expiresAt:issued+3600000}
  }
}
// Workers fetch owns TLS/ALPN and connection pooling. Do not use the nonworking
// node:http2 stub or invent a Fetch "httpVersion" option. A live APNs acceptance
// check is required on the deployed Worker; mocked tests cannot attest transport.
export async function sendAPNS({deviceToken,providerToken,topic,environment,payload,id,collapseId,expiresAt,signal},{fetcher=fetch}={}) {
  check(typeof deviceToken==='string'&&/^[a-f0-9]{32,512}$/.test(deviceToken)&&deviceToken.length%2===0,'invalid_apns_device_token')
  check(['production','sandbox'].includes(environment),'apns_configuration_invalid',503)
  const body=JSON.stringify(payload)
  check(new TextEncoder().encode(body).byteLength<=4096,'apns_payload_too_large',413)
  const background=!payload.aps?.alert
  return withDeadline(12000,signal,async deadline=>{
    let response
    try {
      response=await fetcher((environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com')+'/3/device/'+deviceToken,
        {method:'POST',redirect:'manual',signal:deadline,headers:{Authorization:'bearer '+providerToken,'Content-Type':'application/json',
          'apns-topic':topic,'apns-push-type':background?'background':'alert','apns-priority':background?'5':'10',
          'apns-id':id,'apns-collapse-id':collapseId,'apns-expiration':String(Math.floor(expiresAt/1000))},body})
    } catch {return {status:'retry',code:'apns_transport_unknown',ambiguous:true}}
    if(response.status===200) {
      await response.body?.cancel().catch(()=>{})
      return {status:'accepted',providerId:response.headers.get('apns-id')||id}
    }
    let data={}
    try {data=await boundedJSON(response,4096)} catch {}
    const code=typeof data.reason==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(data.reason)?data.reason:'apns_http_error'
    const invalid=['BadDeviceToken','DeviceTokenNotForTopic','Unregistered'].includes(code)||response.status===410
    return {status:invalid?'invalid':response.status===429||response.status>=500?'retry':'failed',code,httpStatus:response.status,
      ...(Number.isFinite(data.timestamp)?{invalidatedAt:data.timestamp}:{})}
  })
}

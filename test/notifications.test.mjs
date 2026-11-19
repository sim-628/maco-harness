import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from './support/storage.mjs'
import { Store } from '../src/store.mjs'
import { AccountNotificationService } from '../src/notifications/index.mjs'
import { NotificationRegistryService } from '../src/notifications/registry.mjs'
import { APNsTokenProvider } from '../src/notifications/apns.mjs'
import { verifyGmailPush,graphValidationResponse,parseGraphPush,verifyGraphItem } from '../src/notifications/webhooks.mjs'
import { b64JSON,digest } from '../src/notifications/common.mjs'
import { toBase64Url } from '../src/connections/crypto.mjs'

const owner='a'.repeat(64),otherOwner='b'.repeat(64),baseTime=1795000000000
const baseEnv={CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,91).toString('base64'),NOTIFICATION_BASE_URL:'https://maco.example.com',
  GMAIL_PUBSUB_TOPIC:'projects/maco-project/topics/mail',GMAIL_PUBSUB_SUBSCRIPTION:'projects/maco-project/subscriptions/push',
  GMAIL_PUBSUB_AUDIENCE:'https://maco.example.com/webhooks/gmail',GMAIL_PUBSUB_SERVICE_ACCOUNT:'push@maco-project.iam.gserviceaccount.com'}
const apnsEnv={...baseEnv,APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_PRIVATE_KEY:'configured-by-provider',APNS_TOPIC:'app.maco.mail',APNS_ENVIRONMENT:'sandbox'}
function storage(t) {const value=createStorage();t.after(()=>value.close());return value}
function registry(t,now=()=>baseTime) {
  const value=new NotificationRegistryService(storage(t),baseEnv,{now})
  return {value,port:{register:r=>value.register(r),unregister:r=>value.unregister(r),lookup:r=>value.lookup(r),forgetOwner:r=>value.forgetOwner(r),apnsToken:async()=>({token:'test-provider-jwt'})}}
}
function fixture(t,{env=baseEnv,fetcher,now=()=>baseTime,port,provider='gmail'}={}) {
  const db=storage(t),store=new Store(db),route=registry(t,now),events=[]
  const meta={id:'mailbox-1',status:'active',epoch:1,provider}
  const service=new AccountNotificationService(store,env,{ownerId:owner,registry:port??route.port,fetcher,now,
    mailMetadata:(id,epoch)=>{assert.equal(id,'mailbox-1');return {...meta}},
    mailContext:async()=>({credential:{provider,accessToken:'private-mail-token'}}),onMailEvent:event=>events.push(event)})
  return {service,store,db,meta,events,registry:route.value}
}
const gmailRoute=(extra={})=>({ownerId:owner,mailboxId:'mailbox-1',provider:'gmail',generation:'generation-one',watchId:'watch-one',
  epoch:1,version:1,email:'User@example.com',expiresAt:baseTime+86400000,...extra})

test('registry supports verified shared-mailbox fanout and rejects stale epochs, conflicting watches and owner IDs',t=>{
  const {value}=registry(t)
  value.register(gmailRoute())
  value.register(gmailRoute({ownerId:otherOwner,mailboxId:'mailbox-2'}))
  assert.equal(value.lookup({provider:'gmail',email:'user@example.com'}).routes.length,2)
  assert.throws(()=>value.register(gmailRoute({ownerId:'a-user-supplied-sub'})),{code:'invalid_notification_owner'})
  assert.throws(()=>value.register(gmailRoute({watchId:'other-watch'})),{code:'notification_route_conflict'})
  value.register(gmailRoute({epoch:2,version:2}))
  assert.throws(()=>value.register(gmailRoute()),{code:'notification_route_stale'})
  assert.equal(value.unregister({ownerId:owner,mailboxId:'mailbox-1',watchId:'watch-one',generation:'generation-one',epoch:1,version:1}).removed,false)
  assert.equal(value.lookup({provider:'gmail',email:'user@example.com'}).routes.length,2)
})

test('registry removal fences a delayed registration, and account deletion rejects old generations',t=>{
  const {value}=registry(t)
  value.unregister({ownerId:owner,mailboxId:'mailbox-1',watchId:'watch-one',generation:'generation-one',epoch:1,version:1})
  assert.throws(()=>value.register(gmailRoute()),{code:'notification_route_revoked'})
  value.register(gmailRoute({version:2}))
  value.forgetOwner({ownerId:owner,generation:'generation-one'})
  assert.throws(()=>value.register(gmailRoute({version:3})),{code:'notification_route_revoked'})
  value.register(gmailRoute({generation:'generation-two',watchId:'watch-two'}))
  assert.equal(value.lookup({provider:'gmail',email:'user@example.com'}).routes[0].generation,'generation-two')
})

test('Gmail ingress validates Google signature, exact service account and audience before accepting message data',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify'])
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey)
  let fetches=0
  const fetcher=async url=>{fetches++;assert.equal(url,'https://www.googleapis.com/oauth2/v3/certs');return Response.json({keys:[{...jwk,kid:'google-key',alg:'RS256',use:'sig'}]})}
  const claims={iss:'https://accounts.google.com',aud:baseEnv.GMAIL_PUBSUB_AUDIENCE,email:baseEnv.GMAIL_PUBSUB_SERVICE_ACCOUNT,email_verified:true,
    sub:'123456',iat:Math.floor(baseTime/1000),exp:Math.floor(baseTime/1000)+3600}
  async function request(overrides={}) {
    const signed=b64JSON({alg:'RS256',kid:'google-key'})+'.'+b64JSON({...claims,...overrides})
    const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(signed))
    return new Request(baseEnv.GMAIL_PUBSUB_AUDIENCE,{method:'POST',headers:{Authorization:'Bearer '+signed+'.'+toBase64Url(signature)},
      body:JSON.stringify({subscription:baseEnv.GMAIL_PUBSUB_SUBSCRIPTION,message:{messageId:'message-1',data:b64JSON({emailAddress:'User@example.com',historyId:'90071992547409930'})}})})
  }
  assert.deepEqual(await verifyGmailPush(await request(),baseEnv,{fetcher,now:()=>baseTime}),{provider:'gmail',email:'user@example.com',messageId:'message-1',historyId:'90071992547409930'})
  for(const change of [{aud:'https://evil.example.com'},{email:'other@project.iam.gserviceaccount.com'},{email_verified:false},{exp:Math.floor(baseTime/1000)-1}]) {
    await assert.rejects(verifyGmailPush(await request(change),baseEnv,{fetcher,now:()=>baseTime}),{code:'notification_push_unauthorized'})
  }
  assert.equal(fetches,1)
  const unsigned=await request();unsigned.headers.set('Authorization','Bearer bad.token.signature')
  await assert.rejects(verifyGmailPush(unsigned,baseEnv,{fetcher,now:()=>baseTime}),{code:'notification_push_unauthorized'})
})

test('Graph validation stays plain text; basic and lifecycle notifications require the matching secret hash',async()=>{
  const response=graphValidationResponse(new Request('https://maco.example.com/webhooks/graph?validationToken=%3Ctoken%3E',{method:'POST'}))
  assert.match(response.headers.get('Content-Type'),/^text\/plain/);assert.equal(await response.text(),'<token>')
  assert.equal(graphValidationResponse(new Request('https://maco.example.com/webhooks/graph')),null)
  const clientState='random-client-state-that-is-private'
  const items=await parseGraphPush(new Request('https://maco.example.com/webhooks/graph',{method:'POST',body:JSON.stringify({value:[
    {subscriptionId:'sub-one',clientState,changeType:'created',resource:'Users/me/messages/mail-one'},
    {subscriptionId:'sub-one',clientState,lifecycleEvent:'reauthorizationRequired'}]})}),{now:()=>baseTime})
  const route={provider:'outlook',subscriptionId:'sub-one',clientStateHash:await digest(clientState)}
  assert.equal(await verifyGraphItem(items[0],route),true)
  assert.equal(await verifyGraphItem({...items[0],clientState:'wrong-state'},route),false)
  assert.equal(items[1].lifecycleEvent,'reauthorizationRequired')
})

test('APNs native secret bindings invalidate the JWT cache on key changes and never use a stale fallback',async t=>{
  async function signingKey() {
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
    const raw=await crypto.subtle.exportKey('pkcs8',pair.privateKey)
    return {pair,pem:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(raw).toString('base64')+'\n-----END PRIVATE KEY-----'}
  }
  let current=await signingKey(),unavailable=false,reads=0
  const env={...apnsEnv,APNS_PRIVATE_KEY:{async get() {
    reads++;if(unavailable)throw Error('private-pem-error');return current.pem
  }}}
  const db=storage(t),provider=new APNsTokenProvider(db,env,{now:()=>baseTime})
  const first=await provider.token()
  assert.equal((await provider.token()).token,first.token)
  current=await signingKey();env.APNS_KEY_ID='KEY7654321'
  const second=await provider.token()
  assert.notEqual(second.token,first.token)
  const [header,claims,signature]=second.token.split('.')
  assert.equal(JSON.parse(Buffer.from(header,'base64url')).kid,'KEY7654321')
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},current.pair.publicKey,
    Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+claims)),true)
  unavailable=true
  await assert.rejects(provider.token(),{code:'apns_key_invalid'})
  unavailable=false
  assert.equal((await provider.token()).token,second.token)
  assert.equal(reads,5)
  assert.doesNotMatch(JSON.stringify(db.sql.exec('SELECT * FROM notification_signer_tokens').toArray()),/BEGIN PRIVATE KEY/)
})

test('APNs JWT is ES256 signed, sealed and reused across registry reconstruction until rotation',async t=>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const pkcs8=await crypto.subtle.exportKey('pkcs8',pair.privateKey)
  const env={...apnsEnv,APNS_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(pkcs8).toString('base64')+'\n-----END PRIVATE KEY-----'}
  const db=storage(t);let now=baseTime
  const provider=new APNsTokenProvider(db,env,{now:()=>now})
  const issued=await Promise.all([provider.token(),provider.token()])
  assert.equal(issued[0].token,issued[1].token)
  const [header,claims,signature]=issued[0].token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:env.APNS_KEY_ID})
  assert.equal(JSON.parse(Buffer.from(claims,'base64url')).iss,env.APNS_TEAM_ID)
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+claims)),true)
  assert.doesNotMatch(JSON.stringify(db.sql.exec('SELECT * FROM notification_signer_tokens').toArray()),new RegExp(header.replaceAll('.','\\.')))
  const restarted=new APNsTokenProvider(db,env,{now:()=>now})
  assert.equal((await restarted.token()).token,issued[0].token)
  now+=46*60000
  assert.notEqual((await restarted.token()).token,issued[0].token)
})

test('APNs installations are private and outbox deduplicates generic background and task notifications',async t=>{
  const calls=[]
  const {service,store}=fixture(t,{env:apnsEnv,fetcher:async(url,options)=>{calls.push({url,options});return new Response(null,{status:200,headers:{'apns-id':options.headers['apns-id']}})}})
  const token='a1'.repeat(32)
  await service.putInstallation({installationId:'device-one',token})
  assert.doesNotMatch(JSON.stringify([service.listInstallations(),store.rows('SELECT * FROM notification_installations')]),new RegExp(token))
  assert.equal(service.enqueue({dedupeKey:'mail-event-one',kind:'mail.updated'}).queued,1)
  assert.equal(service.enqueue({dedupeKey:'mail-event-one',kind:'mail.updated'}).queued,0)
  await service.runNext()
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers['apns-push-type'],'background')
  assert.deepEqual(JSON.parse(calls[0].options.body),{aps:{'content-available':1},maco:{kind:'mail.updated'}})
  assert.equal(store.one('SELECT state FROM notification_outbox').state,'accepted')
  service.enqueue({dedupeKey:'task-event-one',kind:'task.completed',taskId:'task-one',subject:'private subject'})
  await service.runNext()
  assert.equal(calls[1].options.headers['apns-push-type'],'alert')
  assert.doesNotMatch(calls[1].options.body,/private subject/)
  const status=service.status({limit:1})
  assert.equal(status.deliveries.length,1)
  assert.equal(status.deliveries[0].state,'accepted')
  assert.equal(status.deliveries[0].kind,'task.completed')
  assert.ok(status.nextDeliveryBefore)
  assert.doesNotMatch(JSON.stringify(status),new RegExp(token+'|test-provider-jwt|sealed|payload|private subject'))
  assert.equal(service.deliveryPage({before:status.nextDeliveryBefore}).deliveries[0].kind,'mail.updated')
})

test('APNs retries are bounded and reuse notification IDs; invalid device tokens are erased',async t=>{
  let now=baseTime,mode='retry';const ids=[]
  const {service,store}=fixture(t,{env:apnsEnv,now:()=>now,fetcher:async(url,options)=>{
    ids.push(options.headers['apns-id'])
    return Response.json(mode==='retry'?{reason:'ServiceUnavailable'}:{reason:'Unregistered',timestamp:now},{status:mode==='retry'?503:410})
  }})
  await service.putInstallation({installationId:'device-one',token:'ab'.repeat(32)})
  service.enqueue({dedupeKey:'retry',kind:'mail.updated'})
  for(let i=0;i<5;i++) {await service.runNext();now=service.nextDue()??now}
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,1);assert.equal(store.one("SELECT state FROM notification_outbox WHERE dedupe='retry'").state,'failed')
  mode='invalid';service.enqueue({dedupeKey:'invalid',kind:'mail.updated'});await service.runNext()
  assert.equal(service.listInstallations()[0].status,'invalid')
  assert.equal(store.one('SELECT sealed FROM notification_installations').sealed,null)
})

function gmailFetcher(now=()=>baseTime) {
  const calls=[]
  return {calls,fetcher:async(url,options)=>{
    calls.push({url,options});assert.equal(options.headers.Authorization,'Bearer private-mail-token');assert.equal(options.redirect,'manual')
    if(url.endsWith('/profile'))return Response.json({emailAddress:'User@example.com'})
    assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/watch')
    assert.equal(JSON.parse(options.body).topicName,baseEnv.GMAIL_PUBSUB_TOPIC)
    return Response.json({historyId:'12345678901234567890',expiration:String(now()+7*86400000)})
  }}
}
test('Gmail watch uses provider-verified identity, renews through the scheduler and ingests duplicate pushes once',async t=>{
  let now=baseTime
  const remote=gmailFetcher(()=>now),{service,registry:routes,events}=fixture(t,{fetcher:remote.fetcher,now:()=>now})
  assert.equal((await service.watch({mailboxId:'mailbox-1',expectedEpoch:1})).state,'queued')
  await service.runNext()
  assert.equal(service.subscriptions()[0].state,'active')
  const route=routes.lookup({provider:'gmail',email:'user@example.com'}).routes[0]
  assert.equal(route.ownerId,owner)
  const notification={provider:'gmail',email:'user@example.com',messageId:'pubsub-one',historyId:'12345678901234567891'}
  assert.equal((await service.ingest({route,notification})).accepted,true)
  assert.equal((await service.ingest({route,notification})).duplicate,true)
  assert.equal(events.length,2)
  await assert.rejects(service.ingest({route:{...route,ownerId:otherOwner},notification}),{code:'notification_owner_mismatch'})
  now+=86400000;await service.runNext()
  assert.equal(remote.calls.filter(call=>call.url.endsWith('/watch')).length,2)
})

test('unwatch queues an idempotent registry fence and does not stop another owner’s Gmail watch',async t=>{
  const remote=gmailFetcher(),{service,registry:routes}=fixture(t,{fetcher:remote.fetcher})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  const watch=service.subscriptions()[0]
  service.unwatch({mailboxId:'mailbox-1',expectedVersion:watch.version})
  await service.runNext()
  assert.equal(routes.lookup({provider:'gmail',email:'user@example.com'}).routes.length,0)
  assert.equal(remote.calls.some(call=>call.url.endsWith('/stop')),false)
  assert.equal(service.nextDue(),null)
})

test('Graph creates a secret-bound basic subscription, validates pushes and renews rather than recreating',async t=>{
  let now=baseTime,created,creates=0,patches=0
  const fetcher=async(url,options)=>{
    const body=JSON.parse(options.body)
    if(options.method==='POST') {creates++;created=body;assert.equal(body.includeResourceData,false);return Response.json({id:'subscription-one',expirationDateTime:body.expirationDateTime})}
    assert.equal(options.method,'PATCH');patches++;return Response.json({id:'subscription-one',expirationDateTime:body.expirationDateTime})
  }
  const {service,registry:routes,events,store}=fixture(t,{provider:'outlook',fetcher,now:()=>now})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  assert.equal(creates,1);assert.equal(service.subscriptions()[0].state,'active')
  assert.equal(new URL(created.notificationUrl).pathname,'/webhooks/graph')
  assert.doesNotMatch(JSON.stringify([service.subscriptions(),store.rows('SELECT * FROM notification_subscriptions')]),new RegExp(created.clientState))
  const route=routes.lookup({provider:'outlook',subscriptionId:'subscription-one'}).routes[0]
  await assert.rejects(service.ingest({route,notification:{provider:'outlook',subscriptionId:'subscription-one',clientState:'wrong-state',messageId:'one'}}),{code:'notification_push_unauthorized'})
  await service.ingest({route,notification:{provider:'outlook',subscriptionId:'subscription-one',clientState:created.clientState,messageId:'one',lifecycleEvent:'reauthorizationRequired'}})
  await service.runNext();assert.equal(patches,1);assert.equal(creates,1)
  assert.equal(events.length,3)
})

test('a lost Graph create response is reconciled by its frozen clientState without a second create',async t=>{
  let now=baseTime,created,creates=0
  const fetcher=async(url,options)=>{
    if(options.method==='POST') {creates++;created=JSON.parse(options.body);throw Error('response lost after subscription accepted')}
    assert.equal(options.method,'GET')
    return Response.json({value:[{...created,id:'subscription-recovered'}]})
  }
  const {service}=fixture(t,{provider:'outlook',fetcher,now:()=>now})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  assert.equal(service.subscriptions()[0].state,'unknown')
  now=service.nextDue();await service.runNext()
  assert.equal(creates,1);assert.equal(service.subscriptions()[0].state,'active')
  assert.equal(service.subscriptions()[0].subscriptionId,'subscription-recovered')
})

test('notification reset retains installation/watch configuration but stops old deliveries',async t=>{
  const {service,store}=fixture(t,{env:apnsEnv,fetcher:()=>{throw Error('must not send')}})
  await service.putInstallation({installationId:'device-one',token:'ab'.repeat(32)})
  service.enqueue({dedupeKey:'old-task',kind:'task.completed',taskId:'task-one'})
  service.fence()
  assert.equal(service.listInstallations()[0].status,'active')
  assert.equal(store.one('SELECT state FROM notification_outbox').state,'cancelled')
  assert.equal(await service.runNext(),false)
})

test('registry cleanup failure stays durable and blocks final account erasure',async t=>{
  let broken=true
  const route=registry(t),remote=gmailFetcher()
  const port={...route.port,forgetOwner:body=>{if(broken)throw Error('registry unavailable');return route.port.forgetOwner(body)}}
  const {service,store}=fixture(t,{fetcher:remote.fetcher,port})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  await assert.rejects(service.erase(),/registry unavailable/)
  assert.equal(store.one('SELECT COUNT(*) count FROM notification_registry_jobs').count,1)
  await assert.rejects(service.erase(),/registry unavailable/)
  assert.equal(store.one('SELECT COUNT(*) count FROM notification_registry_jobs').count,1)
  broken=false;await service.erase()
  assert.deepEqual(service.subscriptions(),[])
  assert.equal(route.value.lookup({provider:'gmail',email:'user@example.com'}).routes.length,0)
})

test('notifications construct without optional provider secrets or registry configuration',async t=>{
  const service=new AccountNotificationService(new Store(storage(t)),{})
  assert.deepEqual(service.capabilities(),{apns:false,gmail:false,outlook:false,privatePreviews:true})
  assert.deepEqual(service.enqueue({dedupeKey:'disabled-event',kind:'mail.updated'}),{queued:0,disabled:true})
  assert.deepEqual(service.listInstallations(),[]);assert.deepEqual(service.subscriptions(),[])
  service.recover();assert.equal(service.nextDue(),null);assert.equal(await service.runNext(),false)
  await assert.rejects(service.putInstallation({installationId:'device-one',token:'ab'.repeat(32)}),{code:'apns_not_configured'})
  await service.erase()
})

test('request-session revocation blocks installation and subscription commits after asynchronous encryption',async t=>{
  for(const kind of ['installation','subscription']) {
    const {service}=fixture(t,{env:apnsEnv})
    let release,began,allowed=true
    const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{began=resolve})
    const seal=service.cipher.seal.bind(service.cipher)
    service.cipher.seal=async(...args)=>{const result=await seal(...args);began();await gate;return result}
    const assertAuthorized=()=>{if(!allowed)throw Object.assign(Error('revoked session'),{code:'session_revoked'})}
    const pending=kind==='installation'?service.putInstallation({installationId:'device-one',token:'ab'.repeat(32)},{assertAuthorized}):
      service.watch({mailboxId:'mailbox-1',expectedEpoch:1},{assertAuthorized})
    const rejected=assert.rejects(pending,{code:'session_revoked'})
    await started;allowed=false;release();await rejected
    assert.deepEqual(service.listInstallations(),[]);assert.deepEqual(service.subscriptions(),[])
  }
})

test('account deletion fences an in-flight Graph subscription response and its route registration',async t=>{
  let release,began
  const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{began=resolve})
  const fetcher=async(url,options)=>{
    assert.equal(options.method,'POST');const body=JSON.parse(options.body);began();await gate
    return Response.json({id:'subscription-late',expirationDateTime:body.expirationDateTime})
  }
  const {service,registry:routes}=fixture(t,{provider:'outlook',fetcher})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1})
  const pending=service.runNext();await started
  service.fence({revokeInstallations:true,unsubscribe:true})
  assert.equal(service.activeCount(),1)
  release();await pending
  assert.equal(service.subscriptions()[0].state,'revoked')
  assert.equal(service.subscriptions()[0].subscriptionId,undefined)
  assert.equal(routes.lookup({provider:'outlook',subscriptionId:'subscription-late'}).routes.length,0)
  await service.erase();assert.deepEqual(service.subscriptions(),[])
})

test('Graph conflicts require bounded reconciliation without repeated subscription creation',async t=>{
  let now=baseTime,creates=0,reads=0
  const fetcher=async(url,options)=>{
    if(options.method==='POST') {creates++;return Response.json({error:{code:'Conflict'}},{status:409})}
    assert.equal(options.method,'GET');reads++;return Response.json({value:[]})
  }
  const {service}=fixture(t,{provider:'outlook',fetcher,now:()=>now})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  assert.equal(service.subscriptions()[0].state,'unknown')
  for(let count=0;count<4;count++){now=service.nextDue();await service.runNext()}
  assert.equal(creates,1);assert.equal(reads,4)
  assert.equal(service.subscriptions()[0].state,'unknown');assert.equal(service.nextDue(),null)
})

test('a short valid provider expiry cannot create a continuously due renewal loop',async t=>{
  const fetcher=async(url)=>url.endsWith('/profile')?Response.json({emailAddress:'user@example.com'}):
    Response.json({historyId:'123456',expiration:String(baseTime+5*60000)})
  const {service}=fixture(t,{fetcher})
  await service.watch({mailboxId:'mailbox-1',expectedEpoch:1});await service.runNext()
  assert.equal(service.nextDue(),baseTime+60000)
  assert.equal(await service.runNext(),false)
})

test('an invalidation response for the previous APNs token cannot erase a replacement installation',async t=>{
  let release,began
  const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{began=resolve})
  const fetcher=async()=>{began();await gate;return Response.json({reason:'Unregistered',timestamp:baseTime},{status:410})}
  const {service,store}=fixture(t,{env:apnsEnv,fetcher})
  await service.putInstallation({installationId:'device-one',token:'ab'.repeat(32)})
  service.enqueue({dedupeKey:'before-replacement',kind:'mail.updated'})
  const sending=service.runNext();await started
  await service.putInstallation({installationId:'device-one',expectedEpoch:1,token:'cd'.repeat(32)})
  release();await sending
  assert.equal(service.listInstallations()[0].epoch,2)
  assert.equal(service.listInstallations()[0].status,'active')
  assert.ok(store.one('SELECT sealed FROM notification_installations').sealed)
})

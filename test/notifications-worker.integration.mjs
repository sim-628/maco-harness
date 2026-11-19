import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Miniflare} from 'miniflare'

const issuer='https://notification-login.example/auth/v1'
const origin='https://agent.example'
const source=fileURLToPath(new URL('../src/',import.meta.url))
const worker='maco-notification-integration'
const encode=value=>new TextEncoder().encode(value)
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
const gmailConfig={GMAIL_PUBSUB_TOPIC:'projects/fixture-project/topics/mail',
  GMAIL_PUBSUB_SUBSCRIPTION:'projects/fixture-project/subscriptions/push',
  GMAIL_PUBSUB_AUDIENCE:origin+'/webhooks/gmail',
  GMAIL_PUBSUB_SERVICE_ACCOUNT:'push@fixture-project.iam.gserviceaccount.com'}

async function identities() {
  const loginKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const googleKeys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify'])
  const loginPublic=await crypto.subtle.exportKey('jwk',loginKeys.publicKey)
  const googlePublic=await crypto.subtle.exportKey('jwk',googleKeys.publicKey)
  async function issue(sub,session_id) {
    const now=Math.floor(Date.now()/1000)
    const input=b64({alg:'ES256',kid:'notification-test'})+'.'+b64({sub,session_id,iat:now,
      iss:issuer,aud:'authenticated',role:'authenticated',exp:now+300})
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},loginKeys.privateKey,encode(input))
    return input+'.'+Buffer.from(signature).toString('base64url')
  }
  async function googleToken(overrides={}) {
    const now=Math.floor(Date.now()/1000)
    const input=b64({alg:'RS256',kid:'google-notification-test'})+'.'+b64({iss:'https://accounts.google.com',
      sub:'fixture-google-service-account',aud:gmailConfig.GMAIL_PUBSUB_AUDIENCE,
      email:gmailConfig.GMAIL_PUBSUB_SERVICE_ACCOUNT,email_verified:true,iat:now,exp:now+3600,...overrides})
    const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',googleKeys.privateKey,encode(input))
    return input+'.'+Buffer.from(signature).toString('base64url')
  }
  return {alice:await issue('alice','alice-desktop'),phone:await issue('alice','alice-phone'),bob:await issue('bob','bob-device'),
    loginJWKS:{keys:[{...loginPublic,kid:'notification-test',alg:'ES256',use:'sig'}]},
    googleJWKS:{keys:[{...googlePublic,kid:'google-notification-test',alg:'RS256',use:'sig'}]},googleToken}
}

// This fixture module exists only in Miniflare's in-memory manifest. The public
// entrypoint is the unchanged production Worker: it cannot reach the fixture
// paths. Seed/snapshot requests use the test's private DO namespace binding.
// Pausing the scheduler observes the ingress transaction before any background
// sync or APNs delivery and prevents tests from making real provider requests.
const fixtureModule=`
import production,{MacoAgent,NotificationRegistry} from './worker.mjs'
import {digest} from './notifications/common.mjs'
export default production
export {NotificationRegistry}
export class FixtureAgent extends MacoAgent {
  constructor(ctx,env) {
    super(ctx,env)
    this.service.host.kick=()=>{}
    this.service.host.arm=async()=>{}
  }
  async alarm() {}
  async fetch(request) {
    const path=new URL(request.url).pathname
    if(path==='/__fixture/seed'&&request.method==='POST') {
      const input=await request.json(),service=this.service,store=service.store
      const {mailboxId,provider,subscriptionId,clientState,email,installationId,deviceToken}=input
      const ownerId=this.ctx.id.toString(),watchId=crypto.randomUUID(),generation=service.notifications.identity().generation
      const clientStateHash=provider==='outlook'?await digest(clientState):undefined
      const expiresAt=Date.now()+6*86400000
      const data={watchId,generation,expiresAt,attempts:0,error:null,
        ...(provider==='outlook'?{subscriptionId,clientStateHash}:{email,historyId:'100'})}
      const sealed=await service.notifications.cipher.seal(['watch',mailboxId,watchId],{clientState:clientState||'fixture-gmail-private-state'})
      store.tx(()=>{
        store.rows("INSERT INTO connections(id,kind,provider,account_id,status,epoch,actions,scopes,generation,sealed) VALUES (?,'mail',?,?,'active',1,'[]',?,?,NULL)",
          mailboxId,provider,'provider-account-'+mailboxId,JSON.stringify(provider==='gmail'?['https://www.googleapis.com/auth/gmail.readonly']:['Mail.Read']),crypto.randomUUID())
        service.index.startSync(mailboxId,provider,{after:new Date(Date.now()-86400000).toISOString()})
        const sync=service.index.index.syncState(mailboxId)
        Object.assign(sync,{phase:provider==='gmail'?'gmail_history':'graph_delta',historyId:provider==='gmail'?'100':null,
          cursor:'saved-page-cursor',complete:true,syncedAt:Date.now(),due:Date.now()+3600000,
          ...(provider==='gmail'?{pending:{kind:'gmail_history',ids:['old-message'],next:'saved-next-page',historyId:'110'}}:
            {folders:[{id:'inbox',link:'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=saved',initialComplete:true}]})})
        service.index.index.saveSync(sync)
        store.rows("INSERT INTO notification_subscriptions VALUES (?,?,1,'active',?,1,?,?)",mailboxId,provider,Date.now()+86400000,JSON.stringify(data),sealed)
      })
      const route={ownerId,mailboxId,watchId,generation,epoch:1,version:1,provider,expiresAt,
        ...(provider==='outlook'?{subscriptionId,clientStateHash}:{email})}
      await service.notifications.registry.register(route)
      if(installationId)await service.notifications.putInstallation({installationId,token:deviceToken})
      return Response.json({ownerId,watchId,route})
    }
    if(path==='/__fixture/snapshot') {
      const store=this.service.store
      return Response.json({ownerId:this.ctx.id.toString(),index:store.rows('SELECT * FROM mail_index_meta'),
        sync:store.rows('SELECT data FROM mail_sync').map(row=>JSON.parse(row.data)),
        inbox:store.one('SELECT COUNT(*) count FROM notification_inbox').count,
        outbox:store.rows('SELECT state,data FROM notification_outbox').map(row=>({state:row.state,...JSON.parse(row.data)})),
        status:this.service.notifications.status()})
    }
    return super.fetch(request)
  }
}
`

async function fixture(t) {
  const login=await identities(),counts={jwks:0,googleJWKS:0,unexpected:[]}
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR||tmpdir(),'maco-notifications-'))
  const files=(await readdir(source,{recursive:true})).filter(name=>name.endsWith('.mjs'))
  const modules=Object.fromEntries(await Promise.all(files.map(async path=>[path.split(sep).join('/'),
    {type:'esm',contents:await readFile(join(source,path),'utf8')}])) )
  modules['notification-fixture.mjs']={type:'esm',contents:fixtureModule}
  const bindings={SUPABASE_URL:'https://notification-login.example',CONNECTION_ENCRYPTION_KEY:Buffer.alloc(32,11).toString('base64'),
    NOTIFICATION_BASE_URL:origin,...gmailConfig,APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',
    APNS_PRIVATE_KEY:'unused-because-scheduler-is-paused',APNS_TOPIC:'app.maco.fixture',APNS_ENVIRONMENT:'sandbox'}
  const options={cf:false,resourcePersistencePath:dir,workers:[{
    config:{name:worker,compatibilityDate:'2026-11-18',manifest:{mainModule:'notification-fixture.mjs',modules},
      env:{...Object.fromEntries(Object.entries(bindings).map(([name,value])=>[name,{type:'text',value}])),
        AGENTS:{type:'durable-object',worker,exportName:'FixtureAgent'},
        NOTIFICATIONS:{type:'durable-object',worker,exportName:'NotificationRegistry'},
        ASSETS:{type:'r2',name:'private-notification-fixture-assets'}},
      exports:{FixtureAgent:{type:'durable-object',storage:'sqlite'},NotificationRegistry:{type:'durable-object',storage:'sqlite'}}},
    dev:{outboundService:{type:'fetcher',handler:async request=>{
      if(request.url===issuer+'/.well-known/jwks.json'){counts.jwks++;return Response.json(login.loginJWKS)}
      if(request.url==='https://www.googleapis.com/oauth2/v3/certs'){counts.googleJWKS++;return Response.json(login.googleJWKS)}
      counts.unexpected.push(request.method+' '+new URL(request.url).origin+new URL(request.url).pathname)
      throw Error('Unexpected provider request in ingress-only integration fixture')
    }}},
  }]}
  let mf=new Miniflare(options)
  t.after(async()=>{try{await mf?.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
  const dispatch=(path,init={})=>mf.dispatchFetch(origin+path,init)
  async function json(path,{token,body,method=body===undefined?'GET':'POST',headers={},status=200}={}) {
    const response=await dispatch(path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...headers,
      ...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})
    const value=await response.json()
    assert.equal(response.status,status,JSON.stringify(value))
    return value
  }
  async function account(name,path,body) {
    const namespace=await mf.getDurableObjectNamespace('AGENTS',worker)
    const response=await namespace.get(namespace.idFromName(name)).fetch('https://fixture.internal'+path,
      body?{method:'POST',body:JSON.stringify(body)}:{})
    const value=await response.json()
    assert.equal(response.status,200,JSON.stringify(value));return value
  }
  return {login,counts,dispatch,json,seed:(name,input)=>account(name,'/__fixture/seed',input),
    snapshot:name=>account(name,'/__fixture/snapshot'),
    restart:async()=>{await mf.dispose();mf=new Miniflare(options)}}
}

function graphNotification(subscriptionId,clientState,extra={}) {
  return {subscriptionId,clientState,changeType:'updated',resource:'Users/provider-user/messages/private-message',
    resourceData:{id:'private-message','@odata.etag':'fixture-version'},...extra}
}
const graphSeed=(extra={})=>({provider:'outlook',mailboxId:'same-local-mailbox',subscriptionId:'alice-subscription',
  clientState:'alice-private-client-state-value',installationId:'alice-installation',deviceToken:'ab'.repeat(32),...extra})

test('workerd permits only bounded Graph validation and keeps every internal/fixture endpoint private',{timeout:45000},async t=>{
  const f=await fixture(t)
  const challenge='<plain & challenge>'
  const valid=await f.dispatch('/webhooks/graph?validationToken='+encodeURIComponent(challenge),{method:'POST'})
  assert.equal(valid.status,200);assert.match(valid.headers.get('Content-Type'),/^text\/plain/)
  assert.equal(await valid.text(),challenge)
  assert.equal(f.counts.jwks,0,'provider validation must not depend on a user JWT')
  for(const token of ['', 'a'.repeat(4097), '\0']) {
    const response=await f.dispatch('/webhooks/graph?validationToken='+encodeURIComponent(token),{method:'POST'})
    assert.equal(response.status,400);await response.arrayBuffer()
  }
  const wrongMethod=await f.dispatch('/webhooks/graph?validationToken=token')
  assert.equal(wrongMethod.status,400);await wrongMethod.arrayBuffer()
  const large=await f.dispatch('/webhooks/graph',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({value:[graphNotification('unused-subscription','private-client-state-123')],padding:'x'.repeat(262144)})})
  assert.equal(large.status,413);await large.arrayBuffer()
  await f.json('/v1/notifications',{status:401})
  await f.json('/webhooks/gmail',{body:{},status:401})
  for(const path of ['/internal/notifications/ingest','/internal/account/alice/mail-token','/register','/lookup','/apns-token','/__fixture/seed','/__fixture/snapshot']) {
    for(const token of [undefined,f.login.alice])await f.json(path,{token,body:{ownerId:'alice',route:{},notification:{}},
      headers:{'X-Maco-Session':'alice-desktop','X-Maco-Internal':'1','X-Maco-Owner':'alice'},status:404})
  }
  assert.deepEqual(f.counts.unexpected,[])
})

test('workerd authenticates Graph events, routes by DO ID and isolates notification status across accounts',{timeout:45000},async t=>{
  const f=await fixture(t),alice=graphSeed(),bob=graphSeed({subscriptionId:'bob-subscription',
    clientState:'bob-private-client-state-value',installationId:'bob-installation',deviceToken:'cd'.repeat(32)})
  const seeded=await f.seed('alice',alice);await f.seed('bob',bob)
  assert.match(seeded.ownerId,/^[a-f0-9]{64}$/)
  const before=await f.snapshot('alice'),bobsBefore=await f.snapshot('bob')
  const a=await f.json('/v1/notifications',{token:f.login.phone})
  const b=await f.json('/v1/notifications?ownerId='+seeded.ownerId,{token:f.login.bob,
    headers:{'X-Maco-Owner':seeded.ownerId,'X-Maco-Session':'alice-desktop'}})
  assert.deepEqual(a.installations.map(item=>item.installationId),['alice-installation'])
  assert.deepEqual(b.installations.map(item=>item.installationId),['bob-installation'])
  assert.equal(a.subscriptions[0].subscriptionId,'alice-subscription')
  assert.equal(b.subscriptions[0].subscriptionId,'bob-subscription')
  assert.doesNotMatch(JSON.stringify([a,b]),/private-client-state|abababab|cdcdcdcd|sealed|payload/)
  await f.json('/webhooks/graph',{body:{value:[graphNotification(alice.subscriptionId,'forged-private-client-state')]},status:401})
  assert.deepEqual(await f.snapshot('alice'),before)
  const notification=graphNotification(alice.subscriptionId,alice.clientState,{ownerId:bobsBefore.ownerId,
    historyId:'999999',subject:'Private injected subject',body:'Private injected content'})
  const accepted=await f.json('/webhooks/graph',{body:{value:[notification]},status:202})
  assert.equal(accepted.accepted,1)
  const after=await f.snapshot('alice')
  assert.equal(after.inbox,1);assert.equal(after.index[0].epoch,before.index[0].epoch+1)
  assert.equal(after.sync[0].generation,before.sync[0].generation+1)
  assert.equal(after.sync[0].cursor,before.sync[0].cursor)
  assert.deepEqual(after.sync[0].folders,before.sync[0].folders)
  assert.ok(after.sync[0].due<=Date.now());assert.equal(after.sync[0].syncedAt,0)
  assert.equal(after.outbox.length,1);assert.equal(after.outbox[0].state,'queued')
  assert.deepEqual(after.outbox[0].payload,{aps:{'content-available':1},maco:{kind:'mail.updated'}})
  assert.doesNotMatch(JSON.stringify(after.outbox),/Private injected|private-message|alice-private-client/)
  assert.deepEqual(await f.snapshot('bob'),bobsBefore)
  // getByName(ownerHex) would instantiate this different DO. Correct routing
  // changes Alice's original DO and leaves that accidental hash-of-hash empty.
  const wronglyNamed=await f.snapshot(seeded.ownerId)
  assert.notEqual(wronglyNamed.ownerId,seeded.ownerId)
  assert.deepEqual(wronglyNamed.index,[]);assert.equal(wronglyNamed.inbox,0)
  await f.json('/webhooks/graph',{body:{value:[notification]},status:202})
  assert.deepEqual(await f.snapshot('alice'),after,'a replay must not invalidate or enqueue twice')
  const unknown=await f.json('/webhooks/graph',{body:{value:[graphNotification('missing-subscription','unused-private-client-state')]},status:202})
  assert.equal(unknown.accepted,0);assert.equal(unknown.ignored,1)
  const receipts=await f.json('/v1/notifications/deliveries',{token:f.login.alice})
  assert.equal(receipts.deliveries.length,1)
  assert.deepEqual((await f.json('/v1/notifications/deliveries',{token:f.login.bob})).deliveries,[])
  await f.json('/v1/notifications/unwatch',{token:f.login.alice,
    body:{mailboxId:alice.mailboxId,expectedVersion:a.subscriptions[0].version},status:202})
  // Local revocation is synchronous; registry cleanup is deliberately still
  // queued in this fixture. The live registry entry must not count as accepted.
  const stale=await f.json('/webhooks/graph',{body:{value:[graphNotification(alice.subscriptionId,alice.clientState,
    {resourceData:{id:'late-mail','@odata.etag':'late-version'}})]},status:202})
  assert.deepEqual(stale,{accepted:0,ignored:1})
  assert.equal((await f.snapshot('alice')).outbox.length,1)
  assert.deepEqual(f.counts.unexpected,[],'ingress must not fetch mailbox content, call a model or send APNs synchronously')
})

test('workerd verifies Gmail OIDC and fans out only a sync hint without advancing either account history cursor',{timeout:45000},async t=>{
  const f=await fixture(t),address='shared@example.com'
  const alice={provider:'gmail',mailboxId:'gmail-local-id',email:address,installationId:'alice-google-device',deviceToken:'ab'.repeat(32)}
  const bob={...alice,installationId:'bob-google-device',deviceToken:'cd'.repeat(32)}
  await f.seed('alice',alice);await f.seed('bob',bob)
  const beforeA=await f.snapshot('alice'),beforeB=await f.snapshot('bob')
  const push={subscription:gmailConfig.GMAIL_PUBSUB_SUBSCRIPTION,
    message:{messageId:'pubsub-message-1',data:b64({emailAddress:address,historyId:'90071992547409930'})}}
  const wrong=await f.login.googleToken({email:'different@fixture-project.iam.gserviceaccount.com'})
  await f.json('/webhooks/gmail',{token:wrong,body:push,status:401})
  assert.deepEqual(await f.snapshot('alice'),beforeA);assert.deepEqual(await f.snapshot('bob'),beforeB)
  const token=await f.login.googleToken()
  const accepted=await f.json('/webhooks/gmail',{token,body:push,status:202})
  assert.equal(accepted.accepted,2)
  for(const [name,before] of [['alice',beforeA],['bob',beforeB]]) {
    const after=await f.snapshot(name)
    assert.equal(after.inbox,1);assert.equal(after.index[0].epoch,before.index[0].epoch+1)
    assert.equal(after.sync[0].generation,before.sync[0].generation+1)
    assert.equal(after.sync[0].historyId,'100','a webhook is not proof that intervening history was processed')
    assert.equal(after.sync[0].cursor,'saved-page-cursor')
    assert.deepEqual(after.sync[0].pending,before.sync[0].pending)
    assert.equal(after.outbox.length,1)
    assert.deepEqual(after.outbox[0].payload,{aps:{'content-available':1},maco:{kind:'mail.updated'}})
  }
  await f.json('/webhooks/gmail',{token,body:push,status:202})
  assert.equal((await f.snapshot('alice')).outbox.length,1)
  assert.equal((await f.snapshot('bob')).outbox.length,1)
  assert.equal(f.counts.googleJWKS,1)
  assert.deepEqual(f.counts.unexpected,[])
  await f.restart()
  const aliceStatus=await f.json('/v1/notifications',{token:f.login.phone})
  assert.equal(aliceStatus.deliveries.length,1)
  assert.deepEqual(aliceStatus.installations.map(item=>item.installationId),['alice-google-device'])
  await f.json('/webhooks/gmail',{token,body:push,status:202})
  assert.equal((await f.snapshot('alice')).inbox,1,'durable webhook deduplication survives reconstruction')
})

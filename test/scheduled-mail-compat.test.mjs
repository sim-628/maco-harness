import assert from 'node:assert/strict'
import {register} from 'node:module'
import test from 'node:test'

register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier,context,nextResolve) {
    if (specifier === 'cloudflare:workers') return nextResolve('data:text/javascript,export class DurableObject {}',context)
    return nextResolve(specifier,context)
  }
`)}`,import.meta.url)
const {default:worker,MacoAgent} = await import('../src/worker.mjs')

const origin = 'https://harness.example'
const issuer = 'https://identity.example/auth/v1'
const cloudEndpoint = 'https://maco-agent-cloud.zhengpushen.workers.dev/v1/chat'
const owner = '06f4be0c-7a37-4fc6-9e98-d454d38d56bc'
const session = '19ed9bd6-b394-4fd1-a8a9-6bc11a603337'

async function fixture(t,{revoked=false,upstream}={}) {
  const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const jwk = await crypto.subtle.exportKey('jwk',keys.publicKey)
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now()/1000)
  const signed = `${b64({alg:'ES256',kid:'fixture'})}.${b64({iss:issuer,aud:'authenticated',role:'authenticated',sub:owner,session_id:session,iat:now,exp:now+3600})}`
  const signature = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(signed))
  const authorization = `Bearer ${signed}.${Buffer.from(signature).toString('base64url')}`
  t.mock.method(globalThis,'fetch',async url => {
    assert.equal(url,`${issuer}/.well-known/jwks.json`)
    return Response.json({keys:[{...jwk,kid:'fixture'}]},{headers:{'Cache-Control':'no-store'}})
  })
  let calls = 0
  const actor = Object.create(MacoAgent.prototype)
  actor.env = {MACO_SCHEDULED_MAIL:{async fetch(request) {
    calls++
    assert.equal(request.url,cloudEndpoint)
    assert.equal(request.method,'POST')
    assert.equal(request.redirect,'manual')
    assert.deepEqual(Object.fromEntries(request.headers),{authorization,'content-type':'application/json'})
    return upstream(request)
  }}}
  actor.service = {activeRequests:0,assertAvailable(){},sessions:{
    accept(identity) {
      assert.equal(identity.sessionId,session)
      return identity
    },
    assertActive() {
      if (revoked) throw Object.assign(new Error('session_revoked'),{code:'session_revoked',status:403})
    },
  }}
  const env = {SUPABASE_URL:'https://identity.example',AGENTS:{getByName(account) {
    assert.equal(account,owner)
    return actor
  }}}
  return {
    get calls(){return calls},
    request({body,path='/v1/chat',method='POST',headers={}}={}) {
      return worker.fetch(new Request(origin+path,{method,body,headers:{Authorization:authorization,
        'Content-Type':'application/json','X-Maco-Session':'untrusted','X-Extra-Header':'untrusted',...headers}}),env)
    },
  }
}

test('the Harness forwards all four Scheduled Email operations to the same queue and preserves the Cloud response',async t=>{
  const seen = []
  const harness = await fixture(t,{async upstream(request){
    seen.push(await request.text())
    return Response.json({error:{code:'MAIL_SCHEDULE_CONFLICT'}},{status:409})
  }})
  const operations = ['scheduledMailCreate','scheduledMailList','scheduledMailCancel','scheduledMailUpdate']
  const bodies = operations.map(action => `{"action": "${action}", "message": "Scheduled 📨"}`)
  for (const body of bodies) {
    const response = await harness.request({body,path:'/v1/chat?origin=https://untrusted.example'})
    assert.equal(response.status,409)
    assert.deepEqual(await response.json(),{error:{code:'MAIL_SCHEDULE_CONFLICT'}})
  }
  assert.deepEqual(seen,bodies)
})

test('the compatibility route fences revoked sessions and rejects unrelated, oversized or malformed requests',async t=>{
  const harness = await fixture(t,{upstream(){assert.fail('invalid request reached the Cloud queue')}})
  const authorizedBody = JSON.stringify({action:'scheduledMailList'})
  const cases = [
    [{body:authorizedBody,headers:{Authorization:'Bearer invalid'}},401],
    [{method:'GET'},405],
    [{body:authorizedBody,headers:{Origin:'https://untrusted.example'}},403],
    [{body:authorizedBody,headers:{'Content-Type':'text/plain'}},415],
    [{body:authorizedBody,headers:{'Content-Length':String(17*1024*1024)}},413],
    [{body:'{'},400],
    [{body:JSON.stringify({action:'mailboxList'})},400],
    [{body:authorizedBody,path:'/v1/chat/extra'},404],
  ]
  for (const [request,status] of cases) assert.equal((await harness.request(request)).status,status)
  assert.equal(harness.calls,0)
  const revoked = await fixture(t,{revoked:true,upstream(){assert.fail('revoked session reached the Cloud queue')}})
  assert.equal((await revoked.request({body:authorizedBody})).status,403)
  assert.equal(revoked.calls,0)
})

test('the compatibility proxy declines a redirect and never forwards credentials to a response-supplied origin',async t=>{
  const harness = await fixture(t,{upstream(){return Response.redirect('https://untrusted.example',307)}})
  const response = await harness.request({body:'{"action":"scheduledMailList"}'})
  assert.equal(response.status,502)
  assert.equal(response.headers.get('Location'),null)
  assert.equal(harness.calls,1)
})

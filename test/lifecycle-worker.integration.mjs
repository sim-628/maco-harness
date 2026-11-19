import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,readdir,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Miniflare } from 'miniflare'

const issuer='https://lifecycle-login.example/auth/v1'
const source=fileURLToPath(new URL('../src/',import.meta.url))
const worker='maco-lifecycle-race-integration'
const encode=value=>new TextEncoder().encode(value)
const command=(type,fields={})=>({protocolVersion:1,commandId:crypto.randomUUID(),type,...fields})

async function identities() {
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey)
  async function issue(session_id) {
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
    const now=Math.floor(Date.now()/1000)
    const input=b64({alg:'ES256',kid:'lifecycle-race'})+'.'+b64({sub:'alice',session_id,iat:now,
      iss:issuer,aud:'authenticated',role:'authenticated',exp:now+300})
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,encode(input))
    return input+'.'+Buffer.from(signature).toString('base64url')
  }
  return {jwks:{keys:[{...publicKey,alg:'ES256',kid:'lifecycle-race'}]},
    desktop:await issue('desktop'),phone:await issue('phone')}
}

// Only this test module introduces control routes. The application Worker,
// JWT verification, Durable Object, session ledger and vault run unchanged.
const wrapper=`
  import worker,{MacoAgent} from './worker.mjs';
  const makeBarrier=()=>{
    let release;
    const wait=new Promise(resolve=>{release=resolve});
    return {wait,release,claimed:false,entered:false,activeRequests:0};
  };
  export class LifecycleFixture extends MacoAgent {
    constructor(ctx,env) {
      super(ctx,env);
      this.barriers={};
      const arm=this.service.host.arm.bind(this.service.host);
      this.service.host.arm=async(...args)=>{
        // Background scheduling supplies an explicit time; only the next
        // foreground request's bare arm() is paused. Other requests can run.
        const candidate=this.barriers.arm;
        const barrier=!args.length && candidate && !candidate.claimed ? candidate : null;
        if(barrier)barrier.claimed=true;
        await arm(...args);
        if(barrier){barrier.entered=true;await barrier.wait;}
      };
    }
    async fetch(request) {
      const path=new URL(request.url).pathname;
      if(path==='/__fixture/hold') {
        const {kind}=await request.json();
        if(!['arm','body'].includes(kind))throw Error('Unknown test barrier');
        this.barriers[kind]?.release();
        this.barriers[kind]=makeBarrier();
        return Response.json({held:kind});
      }
      if(path==='/__fixture/release') {
        for(const barrier of Object.values(this.barriers))barrier.release();
        return Response.json({released:true});
      }
      if(path==='/__fixture/state') {
        const models=[];
        for(const meta of this.service.connections.list().filter(item=>item.kind==='model')) {
          const credential=await this.service.connections.modelCredential(meta.id,meta.epoch);
          models.push({id:meta.id,epoch:meta.epoch,originalKey:credential.apiKey==='fixture-original-key'});
        }
        return Response.json({
          barriers:Object.fromEntries(Object.entries(this.barriers).map(([kind,b])=>[kind,
            {claimed:b.claimed,entered:b.entered,activeRequests:b.activeRequests}])),
          account:this.service.lifecycle.status(),
          lifecycleRequests:this.service.store.one('SELECT COUNT(*) AS n FROM account_lifecycle_requests').n,
          models,
        });
      }
      if(request.headers.get('X-Fixture-Slow-Body')==='1') {
        const barrier=this.barriers.body;
        if(!barrier || barrier.claimed)throw Error('Missing test body barrier');
        barrier.claimed=true;
        const bytes=new Uint8Array(await request.arrayBuffer());
        // No eager pull: the barrier is entered by production payload(), after
        // its session was accepted and its active request was registered.
        const body=new ReadableStream({pull:async controller=>{
          barrier.entered=true;
          barrier.activeRequests=this.service.activeRequests;
          await barrier.wait;
          controller.enqueue(bytes);controller.close();
        }},{highWaterMark:0});
        request=new Request(request,{body});
      }
      return super.fetch(request);
    }
  }
  export default {fetch(request,env){
    if(new URL(request.url).pathname.startsWith('/__fixture/'))return env.AGENTS.getByName('alice').fetch(request);
    return worker.fetch(request,env);
  }};
`

async function fixture(t) {
  const login=await identities()
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR || tmpdir(),'maco-lifecycle-race-'))
  const files=(await readdir(source,{recursive:true})).filter(path=>path.endsWith('.mjs'))
  const modules=Object.fromEntries(await Promise.all(files.map(async path=>[
    path.split(sep).join('/'),{type:'esm',contents:await readFile(join(source,path),'utf8')},
  ])))
  modules['lifecycle-fixture.mjs']={type:'esm',contents:wrapper}
  const mf=new Miniflare({cf:false,resourcePersistencePath:dir,workers:[{
    config:{name:worker,compatibilityDate:'2026-11-18',manifest:{mainModule:'lifecycle-fixture.mjs',modules},
      env:{SUPABASE_URL:{type:'text',value:'https://lifecycle-login.example'},
        CONNECTION_ENCRYPTION_KEY:{type:'text',value:Buffer.alloc(32,19).toString('base64')},
        AGENTS:{type:'durable-object',worker,exportName:'LifecycleFixture'},
        ASSETS:{type:'r2',name:'lifecycle-fixture-assets'}},
      exports:{LifecycleFixture:{type:'durable-object',storage:'sqlite'}}},
    dev:{outboundService:{type:'fetcher',handler:async request=>{
      if(request.url===issuer+'/.well-known/jwks.json')return Response.json(login.jwks)
      assert.fail('Unexpected provider I/O: '+new URL(request.url).origin+new URL(request.url).pathname)
    }}},
  }]})
  const dispatch=(token,path,{body,headers={}}={})=>mf.dispatchFetch('https://agent.example'+path,{
    ...(body===undefined ? {} : {method:'POST',body:JSON.stringify(body)}),
    headers:{...(token ? {Authorization:'Bearer '+token} : {}),
      ...(body===undefined ? {} : {'Content-Type':'application/json'}),...headers},
  })
  const read=async(response,status=200)=>{
    response=await response
    const value=await response.json()
    assert.equal(response.status,status,JSON.stringify(value))
    return value
  }
  const request=(token,path,body,status=200)=>read(dispatch(token,path,{body}),status)
  const control=(path,body)=>request(null,'/__fixture/'+path,body)
  t.after(async()=>{
    try {await control('release',{});await mf.dispose()}
    finally {await rm(dir,{recursive:true,force:true})}
  })
  async function entered(kind) {
    const deadline=Date.now()+5000
    let state
    do {
      state=await control('state')
      if(state.barriers[kind]?.entered)return state
      await sleep(10)
    } while(Date.now()<deadline)
    assert.fail('Request did not enter '+kind+' barrier: '+JSON.stringify(state))
  }
  const revoke=()=>request(login.phone,'/v1/commands',command('session.revoke',{
    sessionId:'desktop',expectedVersion:1,
  }),202)
  return {login,dispatch,read,request,control,entered,revoke}
}

test('workerd rejects a lifecycle action when its session is revoked during arm()',{timeout:30000},async t=>{
  for(const action of ['reset','delete'])await t.test(action,async t=>{
    const f=await fixture(t)
    await f.request(f.login.desktop,'/v1/status')
    await f.control('hold',{kind:'arm'})
    const pending=f.dispatch(f.login.desktop,'/v1/account/'+action,{
      body:{requestId:'arm-race-'+action,expectedGeneration:1},
    })
    const held=await f.entered('arm')
    assert.equal(held.account.generation,1)
    assert.equal(held.lifecycleRequests,0,'the barrier must precede lifecycle mutation')
    assert.equal((await f.revoke()).state,'revoked')
    await f.control('release',{})
    assert.deepEqual(await f.read(pending,401),{error:'session_revoked'})
    const after=await f.control('state')
    assert.equal(after.account.state,'active')
    assert.equal(after.account.generation,1)
    assert.equal(after.account.operation,null)
    assert.equal(after.lifecycleRequests,0,'a rejected action must not leave a replay receipt')
    const sessions=await f.request(f.login.phone,'/v1/sessions')
    assert.equal(sessions.sessions.find(row=>row.sessionId==='desktop').state,'revoked')
  })
})

test('workerd rejects model key replacement after session revocation during a slow JSON body',{timeout:30000},async t=>{
  const f=await fixture(t)
  const model=await f.request(f.login.desktop,'/v1/connections/model',{
    provider:'openai',apiKey:'fixture-original-key',
  })
  await f.control('hold',{kind:'body'})
  const pending=f.dispatch(f.login.desktop,'/v1/connections/model',{
    body:{id:model.id,expectedEpoch:model.epoch,provider:'openai',apiKey:'fixture-replacement-key'},
    headers:{'X-Fixture-Slow-Body':'1'},
  })
  const held=await f.entered('body')
  assert.equal(held.barriers.body.activeRequests,1,'production must accept the session before waiting for its body')
  assert.deepEqual(held.models,[{id:model.id,epoch:model.epoch,originalKey:true}])
  assert.equal((await f.revoke()).state,'revoked')
  await f.control('release',{})
  assert.deepEqual(await f.read(pending,401),{error:'session_revoked'})
  assert.deepEqual((await f.control('state')).models,[{id:model.id,epoch:model.epoch,originalKey:true}],
    'returning 401 after committing a new key would still be an authorization failure')
  assert.deepEqual((await f.request(f.login.phone,'/v1/connections')).connections,[model])
})

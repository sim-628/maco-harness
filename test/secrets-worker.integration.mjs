import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'

const worker='maco-secrets-integration'
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))).toString('hex')
const credential={accessToken:'fixture-user-token',refreshToken:'fixture-refresh-token'}

// The entry Worker forwards untouched requests. Secret reads happen inside the
// DO using real workerd env bindings, with no fetch-level env pre-resolution.
const fixtureSource=`
import { DurableObject } from 'cloudflare:workers'
import { hasSecret,readSecret } from './secrets.mjs'
import { VaultCipher } from './connections/crypto.mjs'
import { fingerprint } from './protocol.mjs'

export class SecretProbe extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env)
    this.instance=crypto.randomUUID()
    this.cipher=new VaultCipher(env.VAULT_KEY,'fixture-user')
  }
  async fetch(request) {
    const path=new URL(request.url).pathname
    try {
      if (path==='/read') return Response.json({instance:this.instance,
        configured:hasSecret(this.env.OPERATOR_KEY),
        digest:await fingerprint(await readSecret(this.env.OPERATOR_KEY))})
      if (path==='/seal') {
        const sealed=await this.cipher.seal(['fixture-connection'],await request.json())
        await this.ctx.storage.put('sealed',sealed)
        return Response.json({instance:this.instance,sealedDigest:await fingerprint(sealed)})
      }
      if (path==='/open') {
        const sealed=await this.ctx.storage.get('sealed')
        return Response.json({instance:this.instance,sealedDigest:await fingerprint(sealed),
          digest:await fingerprint(await this.cipher.open(['fixture-connection'],sealed))})
      }
      return new Response(null,{status:404})
    } catch (error) {
      return Response.json({code:error.code||'fixture_failed',beforeDispatch:error.beforeDispatch===true},
        {status:error.status||500})
    }
  }
}
export default {
  fetch(request,env) {
    return env.PROBES.get(env.PROBES.idFromName('fixture-user')).fetch(request)
  }
}
`

async function fixture(t) {
  const dir=await mkdtemp(join(process.env.MACO_TEST_TMPDIR||tmpdir(),'maco-secrets-'))
  const paths=['secrets.mjs','protocol.mjs','connections/crypto.mjs']
  const modules=Object.fromEntries(await Promise.all(paths.map(async path=>[path,
    {type:'esm',contents:await readFile(new URL('../src/'+path,import.meta.url),'utf8')}])))
  modules['fixture.mjs']={type:'esm',contents:fixtureSource}
  const options={cf:false,resourcePersistencePath:dir,workers:[{
    config:{name:worker,compatibilityDate:'2026-11-18',manifest:{mainModule:'fixture.mjs',modules},
      env:{
        PROBES:{type:'durable-object',worker,exportName:'SecretProbe'},
        OPERATOR_KEY:{type:'secrets-store-secret',storeId:'fixture-store',secretName:'operator-credential'},
        VAULT_KEY:{type:'secrets-store-secret',storeId:'fixture-store',secretName:'vault-master-v1'},
      },exports:{SecretProbe:{type:'durable-object',storage:'sqlite'}}},
    dev:{outboundService:{type:'fetcher',handler:()=>{throw Error('Unexpected external request')}}},
  }]}
  let mf=new Miniflare(options)
  t.after(async()=>{try{await mf?.dispose()}finally{await rm(dir,{recursive:true,force:true})}})
  async function secret(binding,operation) {
    const admin=await (await mf.getSecretsStoreSecretAPI(binding,worker))()
    try { return await operation(admin) }
    finally { await admin[Symbol.dispose]?.() }
  }
  async function request(path,body,status=200) {
    const response=await mf.dispatchFetch('https://secrets.example'+path,body ? {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    } : {})
    const result=await response.json()
    assert.equal(response.status,status,JSON.stringify(result))
    return result
  }
  return {secret,request,restart:async()=>{await mf.dispose();mf=new Miniflare(options)}}
}

test('workerd DO reads native Secrets Store updates without rebuilding the DO',{timeout:30000},async t=>{
  const f=await fixture(t)
  const id=await f.secret('OPERATOR_KEY',admin=>admin.create('fixture-operator-key-v1'))
  const first=await f.request('/read')
  assert.equal(first.configured,true)
  assert.equal(first.digest,await digest('fixture-operator-key-v1'))
  await f.secret('OPERATOR_KEY',admin=>admin.update('fixture-operator-key-v2',id))
  const second=await f.request('/read')
  assert.equal(second.instance,first.instance,'rotation must be visible to the existing DO')
  assert.equal(second.digest,await digest('fixture-operator-key-v2'))
  await f.secret('OPERATOR_KEY',admin=>admin.delete(id))
  assert.deepEqual(await f.request('/read',null,503),{code:'secret_unavailable',beforeDispatch:true})
  await f.secret('OPERATOR_KEY',admin=>admin.create('fixture-operator-key-v3'))
  const recovered=await f.request('/read')
  assert.equal(recovered.instance,first.instance)
  assert.equal(recovered.digest,await digest('fixture-operator-key-v3'))
})

test('workerd vault decrypts persisted credentials after reconstruction with a fixed binding key',{timeout:30000},async t=>{
  const f=await fixture(t)
  await f.secret('VAULT_KEY',admin=>admin.create(Buffer.alloc(32,37).toString('base64')))
  const sealed=await f.request('/seal',credential)
  const first=await f.request('/open')
  assert.equal(first.instance,sealed.instance)
  assert.equal(first.digest,await digest(credential))
  await f.restart()
  const restored=await f.request('/open')
  assert.notEqual(restored.instance,first.instance)
  assert.equal(restored.sealedDigest,sealed.sealedDigest)
  assert.equal(restored.digest,await digest(credential))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIHostedClient } from '../src/executors/client.mjs'

const env = {OPENAI_AGENTS_API_KEY:'fixture-server-credential'}

test('hosted transport refuses redirects without forwarding its credential',async () => {
  const urls = []
  const client = new OpenAIHostedClient(env,{fetcher:async (url,options) => {
    urls.push(url)
    assert.equal(options.redirect,'manual')
    return new Response(null,{status:302,headers:{location:'https://attacker.invalid/collect'}})
  }})
  await assert.rejects(client.retrieve('session_1'),{code:'hosted_provider_rejected'})
  assert.deepEqual(urls,['https://api.openai.com/v1/agents/sessions/session_1'])
})

test('artifact response bytes are bounded even when Content-Length is missing or dishonest',async () => {
  for (const headers of [{},{'content-length':'1'}]) {
    const client = new OpenAIHostedClient(env,{fetcher:async () => new Response(new Uint8Array(20),{headers})})
    await assert.rejects(client.artifactBytes('session_1','artifact_1',10),{code:'hosted_response_too_large'})
  }
})

test('a response-body deadline cancels a stalled reader and leaves no held stream',async () => {
  let cancelled = false
  const client = new OpenAIHostedClient(env,{timeoutMS:5,fetcher:async () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }))})
  await assert.rejects(client.retrieve('session_1'),{code:'hosted_unavailable'})
  assert.equal(cancelled,true)
})

test('provider errors never return echoed credential or input content',async () => {
  const client = new OpenAIHostedClient(env,{fetcher:async () => Response.json({error:{message:'fixture-server-credential private attachment'}},{status:400})})
  await assert.rejects(client.retrieve('session_1'),error => {
    assert.equal(error.code,'hosted_provider_rejected')
    assert.equal(error.upstreamStatus,400)
    assert.equal(error.message.includes('private attachment'),false)
    assert.equal(error.message.includes('fixture-server-credential'),false)
    return true
  })
})

test('one hosted client resolves the current binding value for each request',async () => {
  const binding = {value:'fixture-key-one',reads:0,async get() { this.reads++; return this.value }}
  const authorization = []
  const client = new OpenAIHostedClient({OPENAI_AGENTS_API_KEY:binding},{fetcher:async (url,options) => {
    authorization.push(options.headers.Authorization)
    return Response.json({id:'session_1'})
  }})
  await client.retrieve('session_1')
  binding.value = 'fixture-key-two'
  await client.create({input:[]})
  assert.deepEqual(authorization,['Bearer fixture-key-one','Bearer fixture-key-two'])
  assert.equal(binding.reads,2)
})

test('a failed secret lookup dispatches nothing and returns a safe retryable error',async () => {
  let available = false,calls = 0,receipts = 0
  const client = new OpenAIHostedClient({OPENAI_AGENTS_API_KEY:{async get() {
    if (!available) throw new Error('private-key-value account-internal-information')
    return 'fixture-current-key'
  }}},{fetcher:async () => { calls++; return Response.json({id:'session_1'}) }})
  await assert.rejects(client.create({},undefined,{onDispatch:() => { receipts++ }}),error => {
    assert.equal(error.code,'hosted_secret_unavailable')
    assert.equal(error.beforeDispatch,true)
    assert.equal(error.message,'hosted_secret_unavailable')
    assert.equal(JSON.stringify(error).includes('private-key-value'),false)
    return true
  })
  assert.equal(calls,0)
  assert.equal(receipts,0)
  available = true
  await client.create({},undefined,{onDispatch:() => { receipts++ }})
  assert.equal(calls,1)
  assert.equal(receipts,1)
})

test('abort during a binding lookup cannot create a session after the secret arrives',async () => {
  let ready,release,calls = 0,receipts = 0
  const started = new Promise(resolve => { ready = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const client = new OpenAIHostedClient({OPENAI_AGENTS_API_KEY:{get() { ready(); return pending }}},
    {fetcher:async () => { calls++; return Response.json({id:'session_1'}) }})
  const controller = new AbortController()
  const result = client.create({},controller.signal,{onDispatch:() => { receipts++ }})
  await started
  controller.abort()
  await assert.rejects(result,error => error.beforeDispatch === true)
  release('fixture-late-key')
  await Promise.resolve()
  assert.equal(calls,0)
  assert.equal(receipts,0)
})

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

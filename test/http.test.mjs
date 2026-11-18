import test from 'node:test'
import assert from 'node:assert/strict'
import {browserOrigin,preflight,cors} from '../src/http.mjs'

test('browser origin allowlist applies to preflight and websocket while native clients work',() => {
  const env={ALLOWED_ORIGINS:'https://app.macomail.app, http://localhost:3000'}
  assert.equal(browserOrigin(new Request('https://agent.example/v1/snapshot'),env),null)
  assert.equal(browserOrigin(new Request('https://agent.example/v1/snapshot',{headers:{Origin:'https://app.macomail.app'}}),env),'https://app.macomail.app')
  for (const origin of ['null','https://app.macomail.app.evil.example','https://other.example']) {
    assert.throws(() => browserOrigin(new Request('https://agent.example/v1/socket',{headers:{Origin:origin,Upgrade:'websocket'}}),env),{code:'origin_not_allowed'})
  }
  const request = new Request('https://agent.example/v1/commands',{method:'OPTIONS',headers:{Origin:'https://app.macomail.app','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}})
  const response=preflight(request,browserOrigin(request,env))
  assert.equal(response.status,204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://app.macomail.app')
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null)
  assert.throws(() => preflight(new Request(request,{headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-owner'}}),'https://app.macomail.app'),{code:'cors_header_not_allowed'})
})

test('allowed browser origin can read an authentication error without exposing it to another origin',async () => {
  const result=cors(Response.json({error:'unauthorized'},{status:401}),'https://app.macomail.app')
  assert.equal(result.status,401)
  assert.equal(result.headers.get('Access-Control-Allow-Origin'),'https://app.macomail.app')
  assert.deepEqual(await result.json(),{error:'unauthorized'})
})

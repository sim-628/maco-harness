import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.mjs'
import {createStorage} from './support/storage.mjs'
import {buildContext, modelCapabilities, streamStep} from '../src/model/index.mjs'

const tools = [{name:'mail_search', description:'Search mail', inputSchema:{type:'object',properties:{q:{type:'string'}}}}]
const messages = buildContext({messages:[{role:'user',content:'找发票'}], tools})
const call = {id:'c1', name:'mail_search', arguments:{q:'发票'}}
const delta = (delta, finish_reason = null) => ({choices:[{index:0,delta,finish_reason}]})
const chat = [
  delta({tool_calls:[{index:0,id:'c1',type:'function',function:{name:'mail_search',arguments:'{"q":"'}}]}),
  delta({tool_calls:[{index:0,function:{arguments:'发票"}'}}]},'tool_calls'),
  {choices:[],usage:{prompt_tokens:20,completion_tokens:3}}, '[DONE]'
]
const anthropic = [
  {type:'message_start',message:{usage:{input_tokens:20}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'c1',name:'mail_search',input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"q":"发票"}'}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:3}},
  {type:'message_stop'}
]
function streamResponse(events) {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(events.map(event => {
    const lines = typeof event === 'string' ? event : JSON.stringify(event)
    return (event.type ? 'event: ' + event.type + '\r\n' : '') + 'data: ' + lines + '\r\n\r\n'
  }).join(''))
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      // Cut inside UTF-8, JSON and CRLF boundaries.
      controller.enqueue(bytes.slice(offset, offset + 11))
      offset += 11
    }
  }), {headers:{'content-type':'text/event-stream'}})
}

async function run(provider, input, options = {}) {
  const events = options.events ?? []
  const requests = options.requests ?? []
  const profile = {provider, model:{openai:'gpt-5',anthropic:'claude-sonnet-4-6',deepseek:'deepseek-v4-pro'}[provider], connectionId:'c', ...options.profile}
  for await (const event of streamStep({
    profile, credential:{apiKey:'test',...options.credential}, messages:options.messages ?? messages, tools, signal:options.signal,
    fetchImpl:async (url,init) => {
      requests.push({url, init, body:JSON.parse(init.body)})
      return input instanceof Response ? input : streamResponse(input)
    }
  })) events.push(event)
  return {events,requests}
}

for (const [provider,fixture] of [['openai',chat],['anthropic',anthropic]]) {
  test(provider + ' streams one complete call, consumes the same neutral tool history', async () => {
    const first = await run(provider,fixture,{profile:{effort:'medium'}})
    assert.deepEqual(first.events.find(e => e.type === 'tool_call'),{type:'tool_call',...call})
    assert.equal(first.events.findLast(e => e.type === 'usage').outputTokens,3)
    assert.equal(first.events.at(-1).effectiveEffort,'medium')
    assert.equal(first.events.at(-1).reason,'tool_calls')
    const result = 'Message M1'
    const history = [...messages, {role:'assistant',content:'',toolCalls:[call]}, {role:'tool',toolCallId:'c1',content:result}]
    const follow = provider === 'openai'
      ? [delta({content:'M1'},'stop'),'[DONE]']
      : [anthropic[0],
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'M1'}},
        anthropic[3],{type:'message_delta',delta:{stop_reason:'end_turn'}},anthropic[5]]
    const second = await run(provider,follow,{messages:history})
    const body = second.requests[0].body
    if (provider === 'openai') {
      assert.equal(body.messages.at(-2).tool_calls[0].function.arguments,'{"q":"发票"}')
      assert.deepEqual(body.messages.at(-1),{role:'tool',tool_call_id:'c1',content:result})
    } else {
      assert.equal(typeof body.system,'string')
      assert.deepEqual(body.messages.at(-2).content[0],{type:'tool_use',id:'c1',name:'mail_search',input:call.arguments})
      assert.deepEqual(body.messages.at(-1).content[0],{type:'tool_result',tool_use_id:'c1',content:result})
    }
    assert.equal(second.events.find(e => e.type === 'text_delta').text,'M1')
    assert.equal(second.events.at(-1).reason,'stop')
  })
}

test('truncation, missing terminal frames, unfinished blocks and invalid sibling calls dispatch no tool', async () => {
  for (const [provider,fixture] of [
    ['openai',chat.slice(0,-1)],
    ['openai',[chat[0],delta({},'length'),'[DONE]']],
    ['openai',[chat[0],delta({tool_calls:[{index:0,function:{arguments:'x"}'}},{index:1,id:'c2',function:{name:'mail_search',arguments:'['}}]},'tool_calls'),'[DONE]']],
    ['anthropic',anthropic.slice(0,-1)],
    ['anthropic',anthropic.filter(e => e.type !== 'content_block_stop')],
    ['anthropic',anthropic.map(e => e.type === 'content_block_start' ? {...e,content_block:{...e.content_block,name:'unregistered_tool'}} : e)]
  ]) {
    const events = []
    await assert.rejects(run(provider,fixture,{events}))
    assert(!events.some(e => e.type === 'tool_call'))
  }
})

test('effort mapping and native continuation are scoped to the selected DeepSeek connection', async () => {
  const first = await run('deepseek',[delta({reasoning_content:'native-state'}),...chat],{profile:{effort:'medium'}})
  const state = first.events.at(-1).providerState
  assert.equal(first.events[0].type,'warning')
  assert.equal(first.requests[0].body.reasoning_effort,'high')
  assert.equal(state.reasoningContent,'native-state')
  const history = [...messages,{role:'assistant',content:'',toolCalls:[call],providerState:state},{role:'tool',toolCallId:'c1',content:'ok'}]
  const next = await run('deepseek',chat,{messages:history})
  assert.equal(next.requests[0].body.messages.at(-2).reasoning_content,'native-state')
  for (const [provider,profile] of [['openai',{}],['anthropic',{}],['deepseek',{connectionId:'new'}]]) {
    const switched = await run(provider,provider === 'anthropic' ? anthropic : chat,{messages:history,profile})
    assert(!JSON.stringify(switched.requests[0].body).includes('native-state'))
  }
})

test('provider and transport errors preserve retry semantics without reflecting credentials or response bodies', async () => {
  const requests = []
  await assert.rejects(run('openai',new Response('secret',{status:429}),{requests}), error =>
    error.code === 'model_rate_limited' && error.retryable && !error.message.includes('secret'))
  assert.equal(requests.length,1)
  const redirect = new Response(null,{status:302,headers:{location:'https://example.invalid/outside'}})
  const redirected = []
  await assert.rejects(run('openai',redirect,{requests:redirected}),{code:'model_provider_error'})
  assert.equal(redirected.length,1)
  assert.equal(redirected[0].init.redirect,'manual')
  await assert.rejects(run('openai',chat,{signal:AbortSignal.abort()}),{code:'model_cancelled'})
  assert.deepEqual(modelCapabilities({provider:'anthropic',model:'unknown'}).efforts,['provider-default'])
  const {events} = await run('openai',[delta({content:'ok'},'stop'),'[DONE]'])
  assert.equal(events.find(e => e.type === 'usage').inputTokens,null)
})

test('context projection preserves goal, latest steering and balanced tool pairs under pressure', () => {
  const goal = {role:'user',content:'Find invoices'}
  const pending = {role:'assistant',content:'',toolCalls:[call]}
  const reply = {role:'tool',toolCallId:'c1',content:'X'.repeat(3000)}
  const latest = {role:'user',content:'only last week'}
  const bounded = buildContext({messages:[goal,pending,reply,latest],maxInputTokens:1800})
  assert.deepEqual(bounded.slice(1),[goal,latest])
  assert.throws(() => buildContext({messages:[goal,reply]}),{code:'unpaired_tool_history'})
  assert.throws(() => buildContext({messages:[goal,pending]}),{code:'unpaired_tool_history'})
  assert.throws(() => buildContext({messages:[goal],maxInputTokens:4}),{code:'task_context_exceeds_budget'})
})

test('the latest long receipt keeps a bounded, explicitly marked prefix without mutating stored evidence', () => {
  const reply = {role:'tool',toolCallId:'c1',content:'{"messageId":"m1","body":"' + '邮件'.repeat(5000) + '"}'}
  const history = [{role:'user',content:'Summarize m1'}, {role:'assistant',content:'',toolCalls:[call]},reply]
  const context = buildContext({messages:history,maxInputTokens:3000})
  assert(context.at(-1).content.includes('m1'))
  assert(context.at(-1).content.includes('truncated'))
  assert(Buffer.byteLength(JSON.stringify(context)) <= 3000)
  assert(!reply.content.includes('truncated'))
  assert(reply.content.endsWith('邮件"}'))
})

test('Anthropic signed blocks replay privately with the matching model and exact block order', async () => {
  const signed = {type:'thinking',thinking:'private',signature:'signature'}
  const fixture = [anthropic[0],{type:'content_block_start',index:1,content_block:{type:'thinking',thinking:''}},
    {type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'private'}},
    {type:'content_block_delta',index:1,delta:{type:'signature_delta',signature:'signature'}},
    {type:'content_block_stop',index:1},...anthropic.slice(1)]
  const {events} = await run('anthropic',fixture)
  assert(events.every(e => e.type === 'finish' || !JSON.stringify(e).includes('private')))
  const state = events.at(-1).providerState
  assert.deepEqual(state.blocks[0],signed)
  const history = [...messages,{role:'assistant',content:'',toolCalls:[call],providerState:state},{role:'tool',content:'done',toolCallId:'c1'}]
  const next = await run('anthropic',anthropic,{messages:history})
  assert.deepEqual(next.requests[0].body.messages.at(-2).content[0], signed)
  const switched = await run('openai',chat,{messages:history})
  assert(!JSON.stringify(switched.requests[0].body).includes('signature'))
})

test('SQLite context paging preserves the task goal and steering when the suffix starts inside parallel reads', t => {
  const storage = createStorage()
  t.after(() => storage.close())
  const store = new Store(storage)
  const task = {id:'task-1',runId:'run-1'}
  const append = value => store.appendMessage(task,value)
  append({role:'user',content:'复核六月账单'})
  append({role:'assistant',content:'好的。'})
  append({role:'user',content:'优先找张三的确认邮件。'})
  // 81 messages, so the left edge of an 80-row page cuts through the first call's results.
  for (let i = 0; i < 27; i++) {
    const left = {...call,id:'left-'+i}
    const right = {...call,id:'right-'+i}
    append({role:'assistant',content:'',toolCalls:[left,right]})
    append({role:'tool',toolCallId:left.id,content:'张三：邮件编号一。'})
    append({role:'tool',toolCallId:right.id,content:'王五：邮件编号二。'})
  }
  const context = buildContext({messages:store.contextMessages(task.id)})
  assert.equal(context[1].content,'复核六月账单')
  assert.equal(context[2].content,'优先找张三的确认邮件。')
  assert.equal(context[3].role,'assistant')
  assert.equal(context.at(-2).content,'张三：邮件编号一。')
  assert.equal(context.at(-1).content,'王五：邮件编号二。')
})

test('step budgets bound cumulative semantic content, frame count and transport bytes', async () => {
  const chunk = '密'.repeat(8200)
  const stream = (...events) => new Response(events.map(event => 'data: '+JSON.stringify(event)+'\n\n').join(''),
    {headers:{'content-type':'text/event-stream'}})
  const reasoning = Array.from({length:4},() => delta({reasoning_content:chunk}))
  const argumentsOnly = Array.from({length:4},() => delta({tool_calls:[{index:0,function:{arguments:chunk}}]}))
  for (const [provider, body] of [
    ['deepseek',stream(...reasoning)],
    ['openai',stream(chat[0],...argumentsOnly)],
    ['anthropic',stream(anthropic[0],{type:'content_block_start',index:0,content_block:{type:'redacted_thinking',data:chunk.repeat(4)}})]
  ]) {
    const events = []
    await assert.rejects(run(provider,body,{events}),{code:'model_content_too_large'})
    assert(!events.some(e => ['tool_call','finish'].includes(e.type)))
  }
  const heartbeats = new Response(': pulse\n\n'.repeat(32769),{headers:{'content-type':'text/event-stream'}})
  await assert.rejects(run('openai',heartbeats),{code:'model_stream_too_large'})
  const keepAlive = new TextEncoder().encode(':'+'x'.repeat(64*1024)+'\n\n')
  let count = 0
  const lotsOfBytes = new Response(new ReadableStream({
    pull(controller) {
      if (++count > 130) controller.close()
      else controller.enqueue(keepAlive)
    }
  }),{headers:{'content-type':'text/event-stream'}})
  await assert.rejects(run('anthropic',lotsOfBytes),{code:'model_stream_too_large'})
})

test('usage snapshots survive disconnects and refusals, including cached tokens', async () => {
  const interrupted = []
  const usage = {prompt_tokens:100, completion_tokens:8, total_tokens:108,
    prompt_tokens_details:{cached_tokens:40}, completion_tokens_details:{reasoning_tokens:3}}
  await assert.rejects(run('openai',[{choices:[],usage}],{events:interrupted}),{code:'model_stream_interrupted'})
  assert.deepEqual(interrupted[0],{type:'usage',inputTokens:100,outputTokens:8,totalTokens:108,cacheReadTokens:40,reasoningTokens:3})
  const refused = []
  const start = {type:'message_start',message:{usage:{input_tokens:10, cache_creation_input_tokens:2, cache_read_input_tokens:6}}}
  const end = {type:'message_delta',delta:{stop_reason:'refusal'},usage:{output_tokens:7}}
  await assert.rejects(run('anthropic',[start,end,anthropic.at(-1)],{events:refused}),{code:'model_refusal'})
  assert.deepEqual(refused.filter(e => e.type === 'usage').map(({inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens}) =>
    [inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens]), [[18,null,null,6,2],[18,7,25,6,2]])
})

test('compatible protocol uses only the connection endpoint and reports unsupported effort explicitly', async () => {
  const result = await run('openai-compatible',chat,{
    profile:{model:'Qwen/Qwen3-32B',effort:'high',baseUrl:'https://attacker.example/override'},
    credential:{baseUrl:'https://api.vendor.com/openai/v1/'},
  })
  assert.equal(result.requests.length,1)
  assert.equal(result.requests[0].url,'https://api.vendor.com/openai/v1/chat/completions')
  assert.equal(result.requests[0].init.redirect,'manual')
  assert.equal(result.requests[0].init.headers.Authorization,'Bearer test')
  assert.equal(result.requests[0].body.model,'Qwen/Qwen3-32B')
  assert.equal(result.requests[0].body.max_tokens,4096)
  assert.equal(result.requests[0].body.max_completion_tokens,undefined)
  assert.equal(result.requests[0].body.reasoning_effort,undefined)
  assert.equal(result.requests[0].body.stream_options,undefined)
  assert.deepEqual(result.events[0],{type:'warning',code:'model_effort_unsupported',requestedEffort:'high',effectiveEffort:null})
  assert.deepEqual(result.events.find(e=>e.type==='tool_call'),{type:'tool_call',...call})
  assert.equal(result.events.at(-1).effectiveEffort,null)
  assert.deepEqual(modelCapabilities({provider:'openai-compatible',model:'Qwen/Qwen3-32B'}).efforts,['provider-default'])
  const preset = await run('openai',chat,{credential:{baseUrl:'https://attacker.example/override'}})
  assert.equal(preset.requests[0].url,'https://api.openai.com/v1/chat/completions')
})

test('compatible endpoints fail before I/O without trusted connection metadata and never follow a redirect', async () => {
  const requests=[]
  for (const credential of [{},{baseUrl:'http://api.vendor.com/v1'},{baseUrl:'https://127.1/v1'}]) {
    await assert.rejects(run('openai-compatible',chat,{
      requests,profile:{model:'model-1',baseUrl:'https://api.vendor.com/v1'},credential,
    }),{code:'invalid_model_base_url'})
  }
  assert.equal(requests.length,0)
  await assert.rejects(run('openai-compatible',new Response(null,{status:307,headers:{Location:'https://private.example/steal'}}),{
    requests,profile:{model:'model-1'},credential:{baseUrl:'https://api.vendor.com/v1'},
  }),{code:'model_provider_error'})
  assert.equal(requests.length,1)
  assert.equal(requests[0].init.redirect,'manual')
})

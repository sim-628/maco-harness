import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.mjs'
import { HostedExecutionService } from '../src/executors/index.mjs'
import { createStorage } from './support/storage.mjs'

const encoder = new TextEncoder()
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n => n.toString(16).padStart(2,'0')).join('')
const env = {HOSTED_AGENT_ENABLED:'true',OPENAI_AGENTS_API_KEY:'fixture-server-credential',HOSTED_AGENT_MODEL:'configured-model'}
const spec = {parentTaskId:'task',runId:'run',runVersion:1,instructions:'Analyze the supplied materials.',input:'Selected task context only.'}
const response = (body,status = 200) => Response.json(body,{status})
const listing = data => ({data,has_more:false,last_id:data.at(-1)?.id ?? null})

function provider() {
  const p = {calls:[],sessions:new Map(),files:new Map(),artifacts:[],text:'Analysis complete.',nextStatus:'idle',credential:'fixture-server-credential',
    lostCreate:0,lostUpload:0,confirmCancel:false,hook:null}
  p.fetch = async (url,options = {}) => {
    const parsed = new URL(url),path = parsed.pathname,method = options.method || 'GET'
    assert.equal(parsed.origin,'https://api.openai.com')
    assert.equal(options.redirect,'manual')
    assert.equal(options.headers.Authorization,'Bearer '+p.credential)
    assert.equal(options.headers['OpenAI-Beta'],'agents=v1')
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
    const call = {path,method,body,query:parsed.searchParams}
    p.calls.push(call)
    const override = await p.hook?.(call,options)
    if (override) return override
    if (path === '/v1/agents/sessions' && method === 'POST') {
      const id = 'session_'+(p.sessions.size+1)
      const session = {id,metadata:body.metadata,status:p.nextStatus,environment:{id:'environment_'+id},
        required_actions:[],created_at:1000,turnStatus:'completed'}
      p.sessions.set(id,session)
      if (p.lostCreate-- > 0) throw new TypeError('network response lost')
      return response(session,201)
    }
    if (path === '/v1/agents/sessions') return response(listing([...p.sessions.values()].filter(s => !s.deleted)))
    if (path === '/v1/files' && method === 'POST') {
      const file = body.get('file'),id = 'file_'+(p.files.size+1)
      p.files.set(id,{id,filename:file.name,bytes:file.size})
      if (p.lostUpload-- > 0) throw new TypeError('upload acknowledgement lost')
      return response(p.files.get(id))
    }
    if (path === '/v1/files') return response(listing([...p.files.values()].filter(f => !f.deleted)))
    const file = /^\/v1\/files\/([^/]+)$/.exec(path)
    if (file && method === 'DELETE') {
      if (p.files.has(file[1])) p.files.get(file[1]).deleted = true
      return new Response(null,{status:204})
    }
    const match = /^\/v1\/agents\/sessions\/([^/]+)(.*)$/.exec(path)
    assert.ok(match,'unexpected API path '+path)
    const session = p.sessions.get(match[1]),suffix = match[2]
    if (!session || session.deleted) return response({error:{}},404)
    if (!suffix && method === 'GET') return response(session)
    if (!suffix && method === 'DELETE') { session.deleted = true; return new Response(null,{status:204}) }
    if (suffix === '/events') {
      assert.deepEqual(body.events,[{type:'agent.session.input.cancel'}])
      assert.ok(options.headers['Idempotency-Key'].startsWith('cancel:'))
      if (p.confirmCancel) { session.status = 'idle'; session.turnStatus = 'cancelled' }
      return new Response(null,{status:202})
    }
    if (suffix === '/turns') return response(listing([{id:'turn_'+session.id,session_id:session.id,
      status:session.turnStatus,subagent_id:null,usage:p.omitUsage ? undefined : {
        input_tokens:120,output_tokens:30,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:10}}}]))
    if (/^\/turns\/[^/]+\/items$/.test(suffix)) return response(listing([
      {id:'reasoning_private',type:'reasoning',summary:[{text:'private reasoning must not be persisted'}]},
      {id:'answer_'+session.id,type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:p.text}]},
    ]))
    if (suffix === '/artifacts') return response(listing(p.artifacts.map(a => ({id:a.id,
      session_id:a.session_id || session.id,turn_id:a.turn_id || 'turn_'+session.id,
      path:a.path,size_bytes:a.size ?? a.bytes.length,environment_id:session.environment.id}))))
    const artifact = /^\/artifacts\/([^/]+)\/content$/.exec(suffix)
    if (artifact) return new Response(p.artifacts.find(a => a.id === artifact[1]).bytes)
    throw new Error('unexpected API path '+path)
  }
  return p
}

function fixture(t,{environment = env,complete,invalidated,assertCurrent,assets = true} = {}) {
  const storage = createStorage(),store = new Store(storage),p = provider(),completed = []
  t.after(() => storage.close())
  let time = 1_000_000
  store.tx(() => store.saveTask({id:'task',runId:'run',version:1,state:'running'}))
  const values = new Map(),receipts = new Map(),removed = []
  const files = {
    validateRefs(ids) { for (const id of ids) assert.ok(values.has(id),'missing authorized asset') },
    async bytes(id,{maxBytes}) {
      const value = values.get(id)
      if (!value) throw Object.assign(new Error('asset missing'),{code:'asset_not_found',status:404})
      assert.ok(value.bytes.length <= maxBytes)
      return {asset:value.asset,bytes:value.bytes}
    },
    async put(value) {
      const digest = await sha(value.body)
      assert.equal(digest,value.expectedSha256)
      assert.equal(value.size,value.body.length)
      const prior = receipts.get(value.idempotencyKey)
      if (prior) { assert.equal(prior.sha256,digest); return prior }
      const meta = {id:'output_'+(receipts.size+1),name:value.name,mimeType:value.mimeType,size:value.body.length,
        sha256:digest,createdAt:time,taskId:value.taskId,source:value.source}
      values.set(meta.id,{asset:meta,bytes:value.body})
      receipts.set(value.idempotencyKey,meta)
      return meta
    },
    async remove(id) { values.delete(id); removed.push(id) },
  }
  const options = {assets:assets ? files : undefined,fetcher:p.fetch,now:() => time,assertCurrent,
    onComplete:complete || (job => completed.push(job)),onInvalidated:invalidated}
  let executor = new HostedExecutionService(store,{...environment},options)
  const f = {storage,store,p,files,values,receipts,removed,completed,options,
    get executor() { return executor },
    setTime(value) { time = value },
    async input(id = 'input',text = 'document content',name = 'report.txt') {
      const bytes = encoder.encode(text),asset = {id,name,mimeType:'text/plain',size:bytes.length,sha256:await sha(bytes)}
      values.set(id,{asset,bytes}); return id
    },
    restart(overrides = {}) { executor = new HostedExecutionService(store,{...environment},{...options,...overrides}); executor.recover(); return executor },
    async step() { const due = executor.nextDue(); if (due === null) return false; time = Math.max(time,due); return executor.runNext() },
    async until(predicate,max = 60) {
      for (let i = 0;i < max;i++) { if (predicate()) return; assert.notEqual(executor.nextDue(),null,'work ended before predicate'); await f.step() }
      assert.fail('execution did not reach expected state')
    },
    async drain() { await f.until(() => executor.nextDue() === null) },
  }
  return f
}

test('hosted execution is disabled until the server profile is explicitly configured',t => {
  const f = fixture(t,{environment:{}})
  assert.deepEqual(f.executor.capabilities(),{enabled:false,reason:'hosted_disabled'})
  assert.throws(() => f.executor.start(spec),{code:'hosted_disabled'})
  assert.equal(f.p.calls.length,0)
  const invalid = new HostedExecutionService(f.store,{HOSTED_AGENT_ENABLED:'true'})
  assert.equal(invalid.capabilities().enabled,false)
  assert.throws(() => invalid.start(spec),{code:'hosted_not_configured'})
})

test('secret lookup failure leaves both create and upload safely prepared for a background retry',async t => {
  for (const attachment of [false,true]) await t.test(attachment ? 'upload' : 'create',async t => {
    let available = false
    const binding = {async get() {
      if (!available) throw new Error('operator-key-must-not-be-persisted')
      return 'fixture-server-credential'
    }}
    const f = fixture(t,{environment:{...env,OPENAI_AGENTS_API_KEY:binding}})
    assert.equal(f.executor.capabilities().enabled,true)
    const attachmentIds = attachment ? [await f.input()] : []
    const job = f.executor.start({...spec,attachmentIds})
    await f.step()
    const stored = f.executor.get(job.executionId)
    assert.equal(stored.state,'prepared')
    assert.equal(stored.submitted,false)
    assert.equal(stored.uploads.some(file => file.state === 'uploading'),false)
    assert.equal(stored.lastError,'hosted_secret_unavailable')
    assert.equal(f.p.calls.length,0)
    assert.equal(JSON.stringify(stored).includes('operator-key-must-not-be-persisted'),false)
    available = true
    f.restart()
    await f.drain()
    assert.equal(f.executor.inspect(job.executionId).state,'completed')
    assert.equal(f.p.calls.filter(call => call.method === 'POST' && call.path === '/v1/agents/sessions').length,1)
    assert.equal(f.p.calls.filter(call => call.method === 'POST' && call.path === '/v1/files').length,attachment ? 1 : 0)
  })
})

test('authority revoked while reading a binding prevents both attachment upload and session creation',async t => {
  for (const attachment of [false,true]) await t.test(attachment ? 'upload' : 'create',async t => {
    let allowed = true,ready,release
    const started = new Promise(resolve => { ready = resolve })
    const pending = new Promise(resolve => { release = resolve })
    const binding = {get() { ready(); return pending }}
    const f = fixture(t,{environment:{...env,OPENAI_AGENTS_API_KEY:binding},assertCurrent:() => allowed})
    const attachmentIds = attachment ? [await f.input()] : []
    const job = f.executor.start({...spec,attachmentIds})
    const running = f.step()
    await started
    assert.equal(f.executor.get(job.executionId).state,'prepared')
    assert.equal(f.executor.get(job.executionId).submitted,false)
    assert.equal(f.executor.get(job.executionId).uploads.length,0)
    allowed = false
    release('fixture-server-credential')
    await running
    assert.equal(f.p.calls.length,0)
    assert.equal(f.executor.inspect(job.executionId).state,'cancel_requested')
    assert.equal(f.executor.get(job.executionId).submitted,false)
    await f.drain()
    assert.equal(f.executor.inspect(job.executionId).state,'cancelled')
    assert.equal(f.executor.inspect(job.executionId).cleanup,'completed')
    assert.equal(f.p.calls.length,0)
  })
})

test('a live hosted service uses a rotated operator key on subsequent background steps',async t => {
  let current = 'fixture-server-credential',reads = 0
  const binding = {async get() { reads++; return current }}
  const f = fixture(t,{environment:{...env,OPENAI_AGENTS_API_KEY:binding}})
  const job = f.executor.start(spec)
  await f.step()
  current = f.p.credential = 'fixture-rotated-credential'
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).state,'completed')
  assert.equal(reads,f.p.calls.length)
  assert.ok(reads > 1)
  const stored = JSON.stringify(f.executor.get(job.executionId))
  assert.equal(stored.includes('fixture-server-credential'),false)
  assert.equal(stored.includes('fixture-rotated-credential'),false)
})

test('one scoped task completes, records usage and cleans its dedicated session without business tools',async t => {
  const f = fixture(t)
  const job = f.executor.start({...spec,authority:{privacyEpoch:7,modelEpoch:2}})
  assert.throws(() => f.executor.start({...spec,profile:'unconfigured-profile'}),{code:'hosted_profile_not_allowed'})
  await f.drain()
  const result = f.executor.inspect(job.executionId)
  assert.equal(result.state,'completed')
  assert.equal(result.result.text,'Analysis complete.')
  assert.equal(result.cleanup,'completed')
  assert.equal(result.usage.inputTokens,120)
  assert.equal(result.usage.billingComplete,false)
  assert.equal(f.completed.length,1)
  assert.equal(f.p.sessions.size,1)
  assert.ok([...f.p.sessions.values()][0].deleted)
  const created = f.p.calls.find(c => c.path === '/v1/agents/sessions' && c.method === 'POST').body
  assert.equal(created.agent.model,'configured-model')
  assert.deepEqual(created.agent.tools,[])
  assert.deepEqual(created.agent.multi_agent,{enabled:false})
  assert.deepEqual(created.environment.network,{access:'disabled'})
  assert.deepEqual(created.environment.desktop,{enabled:false})
  assert.equal(created.vault_ids,undefined)
  assert.equal(created.environment.env,undefined)
  assert.equal(JSON.stringify(created).includes('privacyEpoch'),false)
  assert.equal(JSON.stringify(created).includes('fixture-server-credential'),false)
  assert.equal(JSON.stringify(result).includes('session_1'),false)
  assert.equal(f.store.one('SELECT COUNT(*) AS n FROM delegation_usage').n,1)
  assert.equal(f.store.one("SELECT instr(data,'private reasoning') AS found FROM delegations").found,0)
})

test('request identity is durable and content checked; separate delegations get separate sessions',async t => {
  const f = fixture(t)
  const first = f.executor.start(spec)
  assert.equal(f.executor.start(spec).executionId,first.executionId)
  assert.throws(() => f.executor.start({...spec,input:'changed'}),{code:'execution_request_conflict'})
  const second = f.executor.start({...spec,requestId:'another-task-part'})
  assert.notEqual(first.executionId,second.executionId)
  await f.drain()
  f.restart()
  assert.equal(f.executor.find(spec).executionId,first.executionId)
  assert.equal(f.executor.start(spec).state,'completed')
  assert.equal(f.p.sessions.size,2)
  assert.equal(f.completed.length,2)
  const disabled = f.restart({onComplete:() => assert.fail('must not repeat completion')})
  disabled.env.HOSTED_AGENT_ENABLED = 'false'
  assert.equal(disabled.find(spec).state,'completed')
  assert.equal(disabled.nextDue(),null)
})

test('a lost creation response reconciles the persisted intent instead of paying for a second session',async t => {
  const f = fixture(t)
  f.p.lostCreate = 1
  const job = f.executor.start(spec)
  await f.step()
  assert.equal(f.executor.inspect(job.executionId).state,'submitting')
  f.restart()
  await f.drain()
  assert.equal(f.p.calls.filter(c => c.method === 'POST' && c.path === '/v1/agents/sessions').length,1)
  assert.equal(f.executor.inspect(job.executionId).state,'completed')
  assert.equal(f.completed.length,1)
})

test('an ambiguous creation never adopts a different account intent and reports an unknown outcome at deadline',async t => {
  const f = fixture(t,{environment:{...env,HOSTED_AGENT_TIMEOUT_MS:'1000'}})
  f.p.lostCreate = 1
  const job = f.executor.start(spec)
  await f.step()
  const remote = [...f.p.sessions.values()][0]
  remote.metadata.maco_scope = 'different-account'
  await f.until(() => f.executor.inspect(job.executionId).state === 'unknown')
  assert.equal(f.completed.length,1)
  assert.equal(f.completed[0].state,'unknown')
  assert.equal(f.p.calls.filter(c => c.method === 'POST' && c.path === '/v1/agents/sessions').length,1)
  assert.equal(f.p.calls.filter(c => c.method === 'DELETE').length,0)
  assert.notEqual(f.executor.nextDue(),null,'unresolved remote cleanup evidence must survive')
})

test('lost upload acknowledgements recover the unique provider file before creating a session',async t => {
  const f = fixture(t)
  const assetId = await f.input()
  f.p.lostUpload = 1
  const job = f.executor.start({...spec,attachmentIds:[assetId]})
  await f.step()
  f.restart()
  await f.drain()
  assert.equal(f.p.calls.filter(c => c.method === 'POST' && c.path === '/v1/files').length,1)
  const created = f.p.calls.find(c => c.method === 'POST' && c.path === '/v1/agents/sessions').body
  assert.equal(created.environment.files[0].type,'file_id')
  assert.match(created.environment.files[0].path,/^\/workspace\/inputs\//)
  assert.equal(created.environment.files[0].file_id,'file_1')
  assert.equal(f.executor.inspect(job.executionId).state,'completed')
  assert.ok(f.p.files.get('file_1').deleted)
  assert.ok(f.values.has(assetId),'input original stays owned by the caller')
})

test('cancel acceptance is not remote completion, and a late success cannot publish a result',async t => {
  const f = fixture(t)
  f.p.nextStatus = 'in_progress'
  const job = f.executor.start(spec)
  await f.step()
  f.executor.cancel(job.executionId)
  await f.step()
  assert.equal(f.executor.inspect(job.executionId).state,'cancel_requested')
  assert.equal(f.completed.length,0)
  assert.equal(f.p.calls.at(-1).path,'/v1/agents/sessions/session_1/events')
  f.p.sessions.get('session_1').status = 'idle'
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).state,'cancelled')
  assert.equal(f.executor.inspect(job.executionId).result,undefined)
  assert.equal(f.completed.length,1)
})

test('an absolute task deadline requests cancellation and waits for the provider to stop',async t => {
  const f = fixture(t,{environment:{...env,HOSTED_AGENT_TIMEOUT_MS:'1000'}})
  f.p.nextStatus = 'in_progress'
  f.p.confirmCancel = true
  const job = f.executor.start(spec)
  await f.step()
  f.setTime(job.deadline+1)
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).state,'failed')
  assert.equal(f.executor.inspect(job.executionId).error,'hosted_deadline_exceeded')
  assert.equal(f.p.calls.filter(c => c.path.endsWith('/events')).length,1)
})

test('a cancellation that cannot be confirmed becomes unknown while retaining remote cleanup evidence',async t => {
  const f = fixture(t)
  f.p.nextStatus = 'in_progress'
  const job = f.executor.start(spec)
  await f.step()
  f.executor.cancel(job.executionId)
  await f.step()
  f.setTime(1_060_001)
  await f.step()
  const state = f.executor.inspect(job.executionId)
  assert.equal(state.state,'unknown')
  assert.equal(state.error,'hosted_cancel_unconfirmed')
  assert.equal(state.cleanup,'pending')
  assert.equal(f.p.sessions.get('session_1').deleted,undefined)
  assert.notEqual(f.executor.nextDue(),null)
})

test('unexpected function or MCP actions are refused, never bridged into mailbox permissions',async t => {
  const f = fixture(t)
  const job = f.executor.start(spec)
  await f.step()
  f.p.sessions.get('session_1').required_actions = [{type:'function_call',name:'mail_send',arguments:{to:'someone@example.com'}}]
  await f.drain()
  const result = f.executor.inspect(job.executionId)
  assert.equal(result.state,'failed')
  assert.equal(result.error,'hosted_action_not_allowed')
  assert.ok(f.p.calls.every(call => !JSON.stringify(call.body ?? null).includes('agent.session.input.tool_result')))
})

test('real turn-bound artifacts are size/type checked, hashed and idempotently copied into private assets',async t => {
  const f = fixture(t)
  f.p.artifacts = [{id:'artifact_csv',path:'/workspace/outputs/totals.csv',bytes:encoder.encode('month,total\nMay,12\n')}]
  const job = f.executor.start(spec)
  await f.drain()
  const result = f.executor.inspect(job.executionId).result
  assert.equal(result.artifacts.length,1)
  assert.equal(result.artifacts[0].mimeType,'text/csv')
  assert.equal(result.artifacts[0].sha256,await sha(f.p.artifacts[0].bytes))
  assert.equal(f.receipts.size,1)
  assert.equal([...f.receipts.values()][0].source.executionId,job.executionId)
  assert.ok(f.p.calls.some(c => c.path === '/v1/agents/sessions/session_1/artifacts/artifact_csv/content'))
  assert.equal(f.removed.length,0)
})

test('a crash-shaped asset acknowledgement loss reuses the same artifact import receipt',async t => {
  const f = fixture(t)
  f.p.artifacts = [{id:'artifact_text',path:'/workspace/outputs/analysis.txt',bytes:encoder.encode('verified result')}]
  const put = f.files.put.bind(f.files)
  let fail = true
  f.files.put = async value => {
    const result = await put(value)
    if (fail) { fail = false; throw new TypeError('lost local asset acknowledgement') }
    return result
  }
  const job = f.executor.start(spec)
  await f.until(() => f.receipts.size === 1)
  f.restart()
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).state,'completed')
  assert.equal(f.receipts.size,1)
  assert.equal(f.completed.length,1)
})

test('oversized or unsupported artifacts are explicitly omitted without downloading them',async t => {
  const f = fixture(t)
  f.p.artifacts = [
    {id:'huge',path:'/workspace/outputs/large.pdf',bytes:encoder.encode('%PDF-'),size:11*1024*1024},
    {id:'html',path:'/workspace/outputs/page.html',bytes:encoder.encode('<script>untrusted</script>')},
  ]
  const job = f.executor.start(spec)
  await f.drain()
  const result = f.executor.inspect(job.executionId).result
  assert.equal(result.coverage.artifactsTruncated,true)
  assert.equal(result.coverage.skipped.length,2)
  assert.equal(f.p.calls.some(c => c.path.endsWith('/content')),false)
  assert.deepEqual(result.artifacts,[])
})

test('artifact metadata cannot point into another session, and corrupt declared types never reach R2',async t => {
  for (const artifact of [
    {id:'foreign',session_id:'another_session',path:'/workspace/outputs/data.txt',bytes:encoder.encode('data')},
    {id:'fake_pdf',path:'/workspace/outputs/report.pdf',bytes:encoder.encode('not a PDF')},
  ]) {
    const f = fixture(t)
    f.p.artifacts = [artifact]
    const job = f.executor.start(spec)
    await f.drain()
    assert.equal(f.executor.inspect(job.executionId).state,'failed')
    assert.equal(f.receipts.size,0)
  }
})

test('steering during artifact I/O suppresses the stale result and cancels the old delegation',async t => {
  const f = fixture(t)
  f.p.artifacts = [{id:'artifact_text',path:'/workspace/outputs/analysis.txt',bytes:encoder.encode('stale result')}]
  const job = f.executor.start(spec)
  await f.until(() => f.executor.get(job.executionId).collection?.phase === 'download')
  let release,ready
  const started = new Promise(resolve => ready = resolve)
  f.p.hook = async call => {
    if (call.path.endsWith('/content')) { ready(); await new Promise(resolve => release = resolve) }
  }
  const pending = f.step()
  await started
  f.store.tx(() => { const parent = f.store.getTask('task'); parent.version = 2; f.store.saveTask(parent) })
  f.executor.cancelForTask('task','parent_changed')
  release()
  await pending
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).result,undefined)
  assert.equal(f.completed.length,0)
  assert.equal(f.receipts.size,0)
})

test('parent completion and delivery receipt commit together and survive reconstruction',async t => {
  let store,attempts = 0
  const f = fixture(t,{complete:() => {
    store.rows('INSERT INTO completion_counter VALUES (1)')
    if (++attempts === 1) throw new Error('simulated transaction failure')
  }})
  store = f.store
  store.rows('CREATE TABLE completion_counter (n INTEGER)')
  const job = f.executor.start(spec)
  await f.until(() => attempts === 1)
  assert.equal(store.one('SELECT COUNT(*) AS n FROM completion_counter').n,0)
  assert.equal(f.executor.inspect(job.executionId).delivered,false)
  f.restart()
  await f.drain()
  assert.equal(store.one('SELECT COUNT(*) AS n FROM completion_counter').n,1)
  assert.equal(f.executor.inspect(job.executionId).delivered,true)
  f.restart()
  assert.equal(await f.executor.runNext(),false)
  assert.equal(attempts,2)
})

test('missing upstream usage stays explicitly incomplete and account-local execution IDs stay isolated',async t => {
  const f = fixture(t),other = fixture(t)
  f.p.omitUsage = true
  const job = f.executor.start(spec)
  assert.throws(() => other.executor.inspect(job.executionId),{code:'execution_not_found'})
  await f.drain()
  assert.equal(f.executor.inspect(job.executionId).usage.available,false)
  assert.equal(f.executor.inspect(job.executionId).usage.incomplete,true)
  assert.equal(f.executor.inspect(job.executionId).usage.inputTokens,undefined)
})

test('authority invalidation delivers one content-free receipt atomically and retries a rolled-back parent notification',async t => {
  let allowed=true,store,attempts=0
  const f=fixture(t,{assertCurrent:()=>{if(!allowed)throw Object.assign(Error(),{code:'connection_revoked'})},
    invalidated:(job,reason)=>{
      assert.equal(reason,'connection_revoked');assert.equal(job.result,undefined);assert.equal(job.delivered,true)
      assert.equal(job.discarded,true);assert.equal(job.invalidationReason,'connection_revoked')
      assert.equal(job.input,undefined);assert.equal(job.sessionId,undefined)
      store.rows('INSERT INTO invalidation_counter VALUES (1)')
      if(++attempts===1)throw Error('parent transaction lost')
    }})
  store=f.store;store.rows('CREATE TABLE invalidation_counter (n INTEGER)')
  const job=f.executor.start(spec)
  await f.until(()=>f.executor.inspect(job.executionId).state==='collecting')
  allowed=false
  await f.until(()=>attempts===1)
  assert.equal(store.one('SELECT COUNT(*) AS n FROM invalidation_counter').n,0)
  assert.equal(f.executor.inspect(job.executionId).delivered,false)
  f.restart();await f.drain()
  assert.equal(store.one('SELECT COUNT(*) AS n FROM invalidation_counter').n,1)
  assert.equal(f.executor.inspect(job.executionId).delivered,true)
  assert.equal(f.completed.length,0)
  f.restart();assert.equal(await f.executor.runNext(),false)
  assert.equal(attempts,2)
})

test('asynchronous invalidation hooks cannot acknowledge a durable parent notification',async t=>{
  let allowed=true
  const f=fixture(t,{assertCurrent:()=>allowed,invalidated:async()=>{}})
  const job=f.executor.start(spec)
  await f.until(()=>f.executor.inspect(job.executionId).state==='running')
  allowed=false
  await f.until(()=>f.executor.get(job.executionId).lastError==='async_execution_invalidation_hook')
  assert.equal(f.executor.inspect(job.executionId).delivered,false)
  let notified=0
  f.restart({onInvalidated:()=>{notified++}});await f.drain()
  assert.equal(notified,1)
})

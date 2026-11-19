import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorage } from './support/storage.mjs'
import { Store } from '../src/store.mjs'
import { AssetService } from '../src/assets/index.mjs'
import { sha256 } from '../src/assets/io.mjs'

const encode = value => new TextEncoder().encode(value)
const pdf = encode('%PDF-1.7\nfixture body\n%%EOF')
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject} }

class Bucket {
  values = new Map()
  puts = []
  deletes = []
  putHook = null
  deleteHook = null
  async put(key,input,options = {}) {
    const bytes = input instanceof Uint8Array ? input.slice() : new Uint8Array(await new Response(input).arrayBuffer())
    if (options.sha256) assert.equal(await sha256(bytes),options.sha256)
    const entry = {key,bytes,size:bytes.length,customMetadata:options.customMetadata || {},httpMetadata:options.httpMetadata || {},
      checksums:options.sha256 ? {sha256:Uint8Array.from(options.sha256.match(/../g),h => parseInt(h,16)).buffer} : {}}
    this.puts.push(key)
    this.values.set(key,entry)
    if (this.putHook) await this.putHook(key,entry)
    return this.head(key)
  }
  async head(key) { const entry = this.values.get(key); if (!entry) return null; const {bytes,...meta} = entry; return structuredClone(meta) }
  async get(key) {
    const entry = this.values.get(key)
    if (!entry) return null
    return {...await this.head(key),body:new Blob([entry.bytes]).stream()}
  }
  async delete(key) {
    if (this.deleteHook) await this.deleteHook(key)
    this.deletes.push(key); this.values.delete(key)
  }
}
function fixture(options = {}) {
  const storage = createStorage()
  const store = new Store(storage)
  const bucket = options.bucket || new Bucket()
  const env = {ASSETS:bucket,...options.env}
  let now = 1_000_000
  const clock = () => now
  const serviceOptions = {ownerId:'user-one',clock,...options.service}
  const assets = new AssetService(store,env,serviceOptions)
  return {storage,store,bucket,env,assets,serviceOptions,advance:ms => {now+=ms},
    reopen:() => new AssetService(store,env,serviceOptions)}
}
function fakeAI(convert,supported = [{extension:'pdf',mimeType:'application/pdf'},{extension:'docx'}]) {
  let calls = 0
  return {get calls(){return calls},toMarkdown(...args) {
    if (!args.length) return {supported:async () => supported}
    calls++; return convert(...args)
  }}
}
function ocrResult(pages = [{index:0,text:'Invoice total 123.00',finish_reason:'stop'}]) {
  return {object:'ocr.result',id:'ocr-test',created:1,purpose:'text_recognition',page_count:pages.length,pages,
    usage:{input_tokens:100,output_tokens:20,total_tokens:120}}
}
const putText = (assets,text = 'hello world',extra = {}) => assets.put({name:'note.txt',mimeType:'text/plain',body:encode(text),...extra})

test('OCR bindings rotate on use and lookup failures remain undispatched and retryable',async t => {
  let key = 'ocr-key-one', unavailable = true, reads = 0
  const used = []
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:{async get() {
    reads++; if (unavailable) throw Error('private-secret-store-detail'); return key
  }}},service:{fetcher:async (_url,init) => {used.push(init.headers.Authorization);return Response.json(ocrResult())}}})
  t.after(() => f.storage.close())
  assert.equal(f.assets.capabilities().parsers.deepseek,true)
  assert.equal(reads,0)
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.state,'failed')
  assert.equal(f.assets.get(asset.id).parse.error,'ocr_not_configured')
  assert.deepEqual(used,[])
  unavailable = false
  f.assets.parse(asset.id,{parser:'deepseek',force:true})
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.state,'succeeded')
  key = 'ocr-key-two'
  f.assets.parse(asset.id,{parser:'deepseek',force:true})
  await f.assets.cleanup()
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.state,'succeeded')
  assert.deepEqual(used,['Bearer ocr-key-one','Bearer ocr-key-two'])
})

test('OCR cancellation or reconstruction during secret lookup never submits an unfenced parse',async t => {
  for (const action of ['cancel','reconstruct']) {
    const gate = deferred(),started = deferred()
    let reads = 0,calls = 0
    const f = fixture({env:{DEEPSEEK_OCR_API_KEY:{async get() {
      reads++; if (reads === 1) {started.resolve();await gate.promise} return 'fixture-key'
    }}},service:{fetcher:async () => {calls++;return Response.json(ocrResult())}}})
    t.after(() => f.storage.close())
    const asset = await f.assets.put({name:'scan.pdf',body:pdf})
    f.assets.parse(asset.id,{parser:'deepseek'})
    const controller = new AbortController()
    const run = f.assets.runNext({signal:controller.signal})
    await started.promise
    if (action === 'cancel') {
      controller.abort()
      await run
      assert.equal(f.assets.get(asset.id).parse.state,'failed')
      assert.equal(calls,0)
      gate.resolve()
    } else {
      const restored = f.reopen()
      restored.recover()
      assert.equal(restored.get(asset.id).parse.state,'queued')
      gate.resolve();await run
      assert.equal(calls,0)
      await restored.runNext()
      assert.equal(restored.get(asset.id).parse.state,'succeeded')
      assert.equal(calls,1)
    }
  }
})

test('R2 asset identity and public metadata isolate users even with a shared bucket',async () => {
  const a = fixture(),b = fixture({bucket:a.bucket,service:{ownerId:'user-two'}})
  const asset = await putText(a.assets)
  assert.ok(a.bucket.puts[0].startsWith('accounts/user-one/assets/'))
  assert.equal(asset.sha256,await sha256(encode('hello world')))
  assert.ok(!JSON.stringify(asset).includes('accounts/'))
  assert.ok(!('key' in asset))
  assert.throws(() => b.assets.get(asset.id),{code:'asset_not_found'})
  assert.throws(() => new AssetService(a.store,a.env,{ownerId:'user-two'}),{code:'asset_owner_mismatch'})
  assert.deepEqual(b.assets.list().assets,[])
  assert.equal((await a.assets.bytes(asset.id)).asset.id,asset.id)
  a.storage.close();b.storage.close()
})

test('upload bounds enforce actual streamed bytes, metadata, digest and MIME before R2 writes',async () => {
  const f = fixture({service:{maxBytes:32}})
  let cancelled = false
  const stream = new ReadableStream({pull(c){c.enqueue(new Uint8Array(20))},cancel(){cancelled=true}})
  await assert.rejects(f.assets.put({name:'binary.bin',body:stream}),{code:'asset_too_large'})
  assert.equal(cancelled,true)
  await assert.rejects(putText(f.assets,'hello',{size:4}),{code:'asset_size_mismatch'})
  await assert.rejects(putText(f.assets,'hello',{expectedSha256:'f'.repeat(64)}),{code:'asset_digest_mismatch'})
  await assert.rejects(f.assets.put({name:'report.pdf',mimeType:'application/pdf',body:'not a PDF'}),{code:'asset_mime_mismatch'})
  await assert.rejects(f.assets.put({name:'report.txt',mimeType:'text/plain',body:pdf}),{code:'asset_mime_mismatch'})
  await assert.rejects(putText(f.assets,'\u0000'),{code:'asset_invalid_encoding'})
  await assert.rejects(putText(f.assets,'x',{name:'../escape.txt'}),{code:'invalid_asset_name'})
  await assert.rejects(putText(f.assets,''),{code:'asset_empty'})
  assert.equal(f.bucket.puts.length,0)
  f.storage.close()
})

test('trusted upload idempotency preserves one asset and rejects changed content or provenance',async () => {
  const f = fixture()
  const extra = {idempotencyKey:'executor:task-one:artifact-one',taskId:'task-one',
    source:{kind:'executor',taskId:'task-one',executionId:'execution-one',artifactId:'artifact-one'}}
  const first = await putText(f.assets,'result',extra)
  assert.equal((await putText(f.assets,'result',extra)).id,first.id)
  assert.equal(f.bucket.puts.length,1)
  await assert.rejects(putText(f.assets,'changed',extra),{code:'asset_idempotency_conflict'})
  await assert.rejects(putText(f.assets,'result',{...extra,source:{...extra.source,artifactId:'other'}}),{code:'asset_idempotency_conflict'})
  f.assets.remove(first.id)
  await assert.rejects(putText(f.assets,'result',extra),{code:'asset_deleted'})
  assert.equal((await f.assets.cleanup()).pending,0)
  assert.equal(f.bucket.values.size,0)
  f.storage.close()
})

test('lost R2 upload response is reconciled from durable intent without duplicate publication',async () => {
  const f = fixture()
  f.bucket.putHook = async () => { throw Error('lost response after persistence') }
  await assert.rejects(putText(f.assets,'durable',{idempotencyKey:'request-1'}),/lost response/)
  assert.equal(f.assets.list().assets.length,0)
  f.bucket.putHook = null
  const restored = f.reopen()
  restored.recover()
  await restored.runNext()
  const again = await putText(restored,'durable',{idempotencyKey:'request-1'})
  assert.equal(restored.list().assets[0].id,again.id)
  assert.equal(f.bucket.puts.length,1)
  f.storage.close()
})

test('erase after reconstruction quarantines uncertain original and parsed R2 writes before metadata purge',async () => {
  for (const kind of ['original','parsed']) {
    const f=fixture()
    if(kind==='original') {
      f.bucket.putHook=async()=>{throw Error('lost R2 reply')}
      await assert.rejects(putText(f.assets,'private delayed object'))
    } else {
      const asset=await putText(f.assets,'private delayed parsed object')
      f.bucket.putHook=async key=>{if(key.includes('/parsed/'))throw Error('lost R2 reply')}
      f.assets.parse(asset.id)
      await f.assets.runNext()
      assert.equal(f.assets.get(asset.id).parse.state,'persisting')
    }
    const restored=f.reopen()
    restored.recover()
    restored.erase()
    assert.equal((await restored.cleanup()).complete,false)
    assert.throws(()=>restored.purgeRetired(),{code:'asset_cleanup_incomplete'})
    assert.equal(restored.nextDue(),1_180_000)
    f.advance(180001)
    assert.equal((await restored.cleanup()).complete,true)
    assert.equal(f.bucket.values.size,0)
    assert.equal(restored.purgeRetired().purged,1)
    f.storage.close()
  }
})

test('asset bytes recheck SHA-256 and downloads reject overrun streams',async () => {
  const f = fixture()
  const asset = await putText(f.assets,'abcdef')
  const key = f.bucket.puts[0]
  f.bucket.values.get(key).bytes = encode('abcdeg')
  await assert.rejects(f.assets.bytes(asset.id),{code:'asset_integrity_error'})
  f.bucket.values.get(key).bytes = encode('longer-than-metadata')
  const download = await f.assets.download(asset.id)
  await assert.rejects(new Response(download.body).arrayBuffer(),{code:'asset_integrity_error'})
  f.storage.close()
})

test('download cancellation and account erase fence an in-flight upload and clean late objects',async () => {
  const f = fixture()
  const gate = deferred()
  const started = deferred()
  f.bucket.putHook = async () => { started.resolve(); await gate.promise }
  const upload = putText(f.assets,'late upload',{idempotencyKey:'late'})
  await started.promise
  assert.equal(f.assets.removeAll().removed,1)
  assert.equal((await f.assets.cleanup()).complete,false)
  assert.equal(f.assets.cleanupStatus().activeUploads,1)
  // Simulate the provider completing after an earlier cleanup pass.
  const key = f.bucket.puts[0]
  const restoreEntry = {key,bytes:encode('late upload'),size:11,customMetadata:{sha256:await sha256(encode('late upload'))},httpMetadata:{},checksums:{}}
  f.bucket.values.set(key,restoreEntry)
  gate.resolve()
  await assert.rejects(upload,{code:'asset_changed'})
  assert.equal((await f.assets.cleanup()).pending,0)
  assert.equal(f.bucket.values.size,0)
  assert.equal(f.assets.list().assets.length,0)
  f.storage.close()
})

test('trusted lifecycle erase drains buffered uploads while ordinary mutations stay blocked',async () => {
  let active = true,cancelled = false
  const f = fixture({service:{assertCurrent:() => {
    if (!active) throw Object.assign(Error('blocked'),{code:'account_inactive',status:409})
  }}})
  const asset = await putText(f.assets,'prior upload',{idempotencyKey:'prior'})
  const readStarted = deferred()
  const stream = new ReadableStream({pull(){readStarted.resolve()},cancel(){cancelled=true}})
  const upload = f.assets.put({name:'blocked.txt',body:stream})
  const rejected = assert.rejects(upload,{code:'asset_changed'})
  await readStarted.promise
  active=false
  assert.throws(() => f.assets.remove(asset.id),{code:'account_inactive'})
  assert.throws(() => f.assets.removeAll(),{code:'account_inactive'})
  assert.equal(f.assets.erase().removed,1)
  assert.equal(f.assets.cleanupStatus().complete,false)
  assert.throws(() => f.assets.purgeRetired(),{code:'asset_cleanup_incomplete'})
  await rejected
  assert.equal(cancelled,true)
  assert.equal(f.assets.retire(asset.id).removed,true)
  assert.equal((await f.assets.cleanup()).complete,true)
  assert.equal(f.bucket.values.size,0)
  assert.deepEqual(f.assets.purgeRetired(),{purged:1})
  const tombstone=JSON.parse(f.store.one('SELECT data FROM maco_assets WHERE id=?',asset.id).data)
  assert.deepEqual(Object.keys(tombstone).sort(),['controlEpoch','due','id','source','state','version'])
  active=true
  assert.throws(() => f.assets.get(asset.id),{code:'asset_not_available',status:410})
  await assert.rejects(putText(f.assets,'prior upload',{idempotencyKey:'prior'}),{code:'asset_deleted'})
  f.storage.close()
})

test('request authorization fences late R2 publication and each read boundary',async () => {
  let authorized=true
  const assertAuthorized=()=>{
    if (!authorized) throw Object.assign(Error('revoked'),{code:'session_revoked',status:401})
  }
  const f=fixture()
  f.bucket.putHook=async()=>{authorized=false}
  await assert.rejects(putText(f.assets,'late authorization',{assertAuthorized}),{code:'session_revoked'})
  assert.equal(f.assets.list().assets.length,0)
  assert.equal((await f.assets.cleanup()).complete,true)
  assert.equal(f.bucket.values.size,0)
  authorized=true;f.bucket.putHook=null
  const asset=await putText(f.assets,'read only while authorized')
  const get=f.bucket.get.bind(f.bucket)
  f.bucket.get=async key=>{const object=await get(key);authorized=false;return object}
  await assert.rejects(f.assets.bytes(asset.id,{assertAuthorized}),{code:'session_revoked'})
  authorized=true
  await assert.rejects(f.assets.download(asset.id,{assertAuthorized}),{code:'session_revoked'})
  f.bucket.get=get;authorized=true
  const download=await f.assets.download(asset.id,{assertAuthorized})
  authorized=false
  await assert.rejects(new Response(download.body).arrayBuffer(),{code:'session_revoked'})
  assert.equal(f.assets.get(asset.id).id,asset.id,'session revocation does not delete an existing user-owned file')
  f.storage.close()
})

test('mail import does not dispatch attachment download after request authorization is revoked',async () => {
  let authorized=true,calls=0
  const mail={metadata:()=>({provider:'gmail',epoch:1}),context:async()=>({mailboxId:'mailbox-one',
    credential:{provider:'gmail',accessToken:'fixture',scopes:['https://www.googleapis.com/auth/gmail.readonly']}})}
  const f=fixture({service:{mail,fetcher:async()=>{
    calls++;authorized=false
    return Response.json({id:'message-one',historyId:'7',payload:{parts:[{partId:'1',filename:'note.txt',mimeType:'text/plain',
      body:{attachmentId:'attachment-one',size:5}}]}})
  }}})
  await assert.rejects(f.assets.importMail({mailboxId:'mailbox-one',messageId:'message-one',attachmentId:'attachment-one',
    assertAuthorized:()=>{if(!authorized)throw Object.assign(Error('revoked'),{code:'session_revoked',status:401})}}),{code:'session_revoked'})
  assert.equal(calls,1)
  assert.equal(f.bucket.puts.length,0)
  f.storage.close()
})

test('mail attachment import retains actual provider metadata and revalidates connection epoch',async () => {
  let epoch = 3,fetches = 0
  const mail = {
    metadata(id,expected) {
      assert.equal(id,'mailbox-one')
      if (expected !== undefined && expected !== epoch) throw Object.assign(Error('revoked'),{code:'connection_changed',status:403})
      return {provider:'gmail',epoch}
    },
    async context(id,expected) {
      this.metadata(id,expected)
      return {mailboxId:id,credential:{provider:'gmail',scopes:['https://www.googleapis.com/auth/gmail.readonly'],accessToken:'fixture-token'}}
    },
  }
  const fetcher = async (url,init) => {
    fetches++;assert.equal(init.redirect,'manual')
    return url.includes('/attachments/') ? Response.json({data:btoa('mail text')}) : Response.json({id:'message-one',historyId:'v4',payload:{parts:[{
      partId:'1',filename:'mail.txt',mimeType:'text/plain',body:{size:9,attachmentId:'attachment-one'},
    }]}})
  }
  const f = fixture({service:{mail,fetcher}})
  const asset = await f.assets.importMail({mailboxId:'mailbox-one',messageId:'message-one',attachmentId:'attachment-one',expectedEpoch:3})
  assert.equal(fetches,2)
  assert.equal(asset.source.epoch,3)
  assert.equal(asset.source.version,'v4')
  assert.equal(new TextDecoder().decode((await f.assets.bytes(asset.id)).bytes),'mail text')
  epoch = 4
  assert.throws(() => f.assets.get(asset.id),{code:'connection_changed'})
  await assert.rejects(f.assets.bytes(asset.id),{code:'connection_changed'})
  assert.deepEqual(f.assets.list().assets,[])
  f.assets.remove(asset.id)
  assert.equal((await f.assets.cleanup()).pending,0)
  f.storage.close()
})

test('mail epoch changing during download prevents importing a revoked attachment',async () => {
  let revoked = false
  const mail = {
    metadata() { if (revoked) throw Object.assign(Error(),{code:'connection_changed',status:403}); return {provider:'gmail',epoch:1} },
    async context() { return {mailboxId:'mailbox-one',credential:{provider:'gmail',scopes:['https://www.googleapis.com/auth/gmail.readonly'],accessToken:'fixture'}} },
  }
  const f = fixture({service:{mail,fetcher:async url => {
    if (url.includes('/attachments/')) {revoked=true;return Response.json({data:btoa('x')})}
    return Response.json({historyId:'h',payload:{parts:[{filename:'x.txt',mimeType:'text/plain',body:{attachmentId:'a',size:1}}]}})
  }}})
  await assert.rejects(f.assets.importMail({mailboxId:'mailbox-one',messageId:'m',attachmentId:'a'}),{code:'connection_changed'})
  assert.equal(f.bucket.puts.length,0)
  f.storage.close()
})

test('local parse jobs survive recovery, expose bounded ranges, and reuse only same-user content',async () => {
  const f = fixture()
  const asset = await putText(f.assets,'first needle\nsecond needle\nthird line')
  const pending = await f.assets.read(asset.id)
  assert.equal(pending.pending,true)
  const restored = f.reopen()
  restored.recover()
  await restored.runNext()
  const view = await restored.read(asset.id,{maxBytes:12})
  assert.equal(view.coverage,'complete')
  assert.equal(view.rangeTruncated,true)
  assert.ok(view.nextOffset > 0)
  assert.equal((await restored.search(asset.id,{query:'needle'})).matches.length,2)
  const clone = await putText(restored,'first needle\nsecond needle\nthird line',{name:'clone.txt'})
  assert.equal(restored.parse(clone.id).id,pending.job.id)
  const parsedKeys = f.bucket.puts.filter(key => key.includes('/parsed/'))
  assert.equal(parsedKeys.length,1)
  restored.remove(asset.id)
  await restored.cleanup()
  assert.ok((await restored.read(clone.id)).text.includes('needle'))
  restored.remove(clone.id)
  await restored.cleanup()
  assert.equal(f.bucket.values.size,0)
  f.storage.close()
})

test('max references and local output clipping remain explicit',async () => {
  const f = fixture({service:{maxRefs:1,maxParsedBytes:4096}})
  const asset = await putText(f.assets,'x'.repeat(6000))
  assert.equal(f.assets.validateRefs([asset.id]).length,1)
  assert.throws(() => f.assets.validateRefs([asset.id,asset.id]),{code:'invalid_asset_references'})
  f.assets.parse(asset.id)
  await f.assets.runNext()
  const result = await f.assets.read(asset.id)
  assert.equal(result.coverage,'partial')
  assert.ok(result.warnings.includes('text_output_truncated'))
  assert.ok(result.text.length < 6000)
  f.storage.close()
})

test('Cloudflare conversion checks supported formats and never labels mixed PDF text complete',async () => {
  const ai = fakeAI(async (input,options) => {
    assert.equal(input.name,'attachment.pdf')
    assert.equal(input.blob.type,'application/pdf')
    assert.deepEqual(options,{conversionOptions:{pdf:{metadata:false},output:{format:'markdown'}}})
    return {format:'markdown',data:'## Text from one page'}
  })
  const f = fixture({env:{AI:ai}})
  const asset = await f.assets.put({name:'mixed.pdf',mimeType:'application/pdf',body:pdf})
  f.assets.parse(asset.id)
  await f.assets.runNext()
  const result = await f.assets.read(asset.id)
  assert.equal(result.coverage,'unverified')
  assert.ok(result.warnings.includes('pdf_scanned_pages_may_be_missing'))
  assert.equal(ai.calls,1)
  f.storage.close()
})

test('empty, per-file error, and dynamically unsupported conversions are explicit failures',async () => {
  for (const [response,supported,code] of [
    [{format:'markdown',data:'  '},undefined,'attachment_no_text'],
    [{format:'error',data:'bad PDF'},undefined,'attachment_conversion_failed'],
    [{format:'markdown',data:'ignored'},[],'unsupported_attachment_type'],
  ]) {
    const ai = fakeAI(async () => response,supported)
    const f = fixture({env:{AI:ai}})
    const asset = await f.assets.put({name:'scan.pdf',body:pdf})
    f.assets.parse(asset.id)
    await f.assets.runNext()
    assert.equal(f.assets.get(asset.id).parse.state,'failed')
    assert.equal(f.assets.get(asset.id).parse.error,code)
    assert.equal(f.assets.get(asset.id).coverage,'unverified')
    f.storage.close()
  }
})

test('image OCR requires an enabled explicit parser and cannot silently use image captions',async () => {
  const f = fixture({env:{AI:fakeAI(async () => ({format:'markdown',data:'A description'}))}})
  const asset = await f.assets.put({name:'scan.png',mimeType:'image/png',body:png})
  assert.throws(() => f.assets.parse(asset.id),{code:'ocr_not_configured'})
  assert.throws(() => f.assets.parse(asset.id,{parser:'cloudflare'}),{code:'unsupported_attachment_type'})
  assert.throws(() => f.assets.parse(asset.id,{parser:'deepseek'}),{code:'ocr_not_configured'})
  f.storage.close()
})

test('DeepSeek OCR uses real multipart protocol and preserves page truncation',async () => {
  let calls = 0
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'fixture-key'},service:{fetcher:async (url,init) => {
    calls++
    assert.equal(url,'https://api.deepseek.com/v1/tools/ocr')
    assert.equal(init.redirect,'manual')
    assert.equal(init.headers.Authorization,'Bearer fixture-key')
    assert.deepEqual([...init.body.keys()].sort(),['file','purpose'])
    assert.equal(init.body.get('purpose'),'text_recognition')
    assert.equal(init.body.get('file').name,'scan.pdf')
    return new Response('\n\n'+JSON.stringify(ocrResult([
      {index:0,text:'<｜ref｜>Invoice<｜/ref｜><｜box｜>[[1,2,3,4]]<｜/box｜>\nTotal 12',finish_reason:'stop'},
      {index:1,text:'Partial page',finish_reason:'length'},
    ])),{headers:{'Content-Type':'application/json'}})
  }}})
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  const result = await f.assets.read(asset.id,{page:1})
  assert.equal(result.coverage,'partial')
  assert.equal(result.pageCount,2)
  assert.equal(result.coverageMeaning,'provider_reported_page_completion')
  assert.ok(result.text.includes('Invoice'))
  assert.ok(!result.text.includes('<｜'))
  assert.equal(calls,1)
  f.storage.close()
})

test('OCR completed page transport does not claim recognition accuracy',async () => {
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'key'},service:{fetcher:async () => Response.json(ocrResult())}})
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  const read = await f.assets.read(asset.id)
  assert.equal(read.coverage,'complete')
  assert.equal(read.coverageMeaning,'provider_reported_page_completion')
  assert.deepEqual(read.job.usage,{input_tokens:100,output_tokens:20,total_tokens:120})
  f.storage.close()
})

test('OCR HTTP-200 error and malformed pages do not become successful parsed assets',async () => {
  for (const response of [{error:{code:'gateway_timeout_error',message:'provider detail'}},{...ocrResult(),page_count:2}]) {
    const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'key'},service:{fetcher:async () => Response.json(response)}})
    const asset = await f.assets.put({name:'scan.pdf',body:pdf})
    f.assets.parse(asset.id,{parser:'deepseek'})
    await f.assets.runNext()
    const job = f.assets.get(asset.id).parse
    assert.equal(job.state,'failed')
    assert.equal(job.error,response.error ? 'ocr_recognition_failed' : 'invalid_parser_response')
    assert.equal(f.assets.nextDue(),null)
    f.storage.close()
  }
})

test('OCR transport uncertainty is durable and never blindly resubmitted after reconstruction',async () => {
  let calls = 0
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'key'},service:{fetcher:async () => {calls++;throw Error('connection lost')}}})
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.state,'unknown')
  const restored = f.reopen();restored.recover()
  assert.equal(restored.nextDue(),null)
  assert.equal((await restored.runNext()).worked,false)
  assert.throws(() => restored.parse(asset.id,{parser:'deepseek',force:true}),{code:'parse_result_unknown'})
  assert.throws(() => restored.parse(asset.id,{parser:'deepseek',force:true,allowRetryUnknown:true}),{code:'parse_result_unknown'})
  f.advance(180001)
  assert.equal(restored.parse(asset.id,{parser:'deepseek',force:true,allowRetryUnknown:true}).state,'queued')
  assert.equal(calls,1)
  f.storage.close()
})

test('unknown OCR retry deadline starts at dispatch after slow R2 loading',async () => {
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'key'},service:{fetcher:async () => {throw Error('connection lost')}}})
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  const get = f.bucket.get.bind(f.bucket)
  f.bucket.get = async key => { f.advance(15000); return get(key) }
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.retryAfter,1_195_000)
  f.advance(165001)
  assert.throws(() => f.assets.parse(asset.id,{parser:'deepseek',force:true,allowRetryUnknown:true}),{code:'parse_result_unknown'})
  f.advance(15000)
  assert.equal(f.assets.parse(asset.id,{parser:'deepseek',force:true,allowRetryUnknown:true}).state,'queued')
  f.storage.close()
})

test('parser result R2 response loss recovers output without a second billable OCR request',async () => {
  let calls = 0
  const f = fixture({env:{DEEPSEEK_OCR_API_KEY:'key'},service:{fetcher:async () => {calls++;return Response.json(ocrResult())}}})
  const asset = await f.assets.put({name:'scan.pdf',body:pdf})
  f.bucket.putHook = async key => {if (key.includes('/parsed/')) throw Error('response lost')}
  f.assets.parse(asset.id,{parser:'deepseek'})
  await f.assets.runNext()
  assert.equal(f.assets.get(asset.id).parse.state,'persisting')
  f.bucket.putHook = null;f.advance(5001)
  const restored = f.reopen();restored.recover()
  await restored.runNext()
  assert.equal(restored.get(asset.id).parse.state,'succeeded')
  assert.match((await restored.read(asset.id)).text,/123\.00/)
  assert.equal(calls,1)
  f.storage.close()
})

test('delete during Cloudflare conversion fences late completion and prevents asset resurrection',async () => {
  const gate = deferred(),started = deferred()
  const ai = fakeAI(async () => {started.resolve();return gate.promise})
  const f = fixture({env:{AI:ai}})
  const asset = await f.assets.put({name:'report.pdf',body:pdf})
  const job = f.assets.parse(asset.id)
  const running = f.assets.runNext()
  await started.promise
  f.assets.remove(asset.id)
  gate.resolve({format:'markdown',data:'late data'})
  await running
  await f.assets.cleanup()
  assert.throws(() => f.assets.get(asset.id),{code:'asset_not_available'})
  assert.equal(JSON.parse(f.store.one('SELECT data FROM maco_asset_parses WHERE id=?',job.id).data).state,'cancelled')
  assert.equal(f.bucket.values.size,0)
  f.storage.close()
})

test('forced replacement retires an unused parse output and cleanup retries durably',async () => {
  const f = fixture()
  const asset = await putText(f.assets)
  f.assets.parse(asset.id);await f.assets.runNext()
  const oldKey = f.bucket.puts.find(key => key.includes('/parsed/'))
  f.assets.parse(asset.id,{force:true})
  f.bucket.deleteHook = async () => {throw Error('temporary R2 failure')}
  await f.assets.cleanup()
  assert.equal(f.bucket.values.has(oldKey),true)
  f.bucket.deleteHook = null;f.advance(6000)
  await f.assets.cleanup()
  assert.equal(f.bucket.values.has(oldKey),false)
  await f.assets.runNext()
  assert.equal((await f.assets.read(asset.id)).text,'hello world')
  f.storage.close()
})

test('public capabilities report parser opt-ins without secrets and storage quotas persist',async () => {
  const f = fixture({service:{maxBytes:16,maxAccountBytes:20,maxFiles:1},env:{DEEPSEEK_OCR_API_KEY:'secret-key'}})
  await putText(f.assets,'short')
  await assert.rejects(putText(f.assets,'another'),{code:'asset_account_limit'})
  const capabilities = f.assets.capabilities()
  assert.equal(capabilities.parsers.deepseek,true)
  assert.equal(capabilities.automaticOCR,null)
  assert.ok(!JSON.stringify(capabilities).includes('secret-key'))
  f.storage.close()
})

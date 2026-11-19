import { fingerprint, errorCode, identifier } from '../protocol.mjs'
import { withDeadline } from '../deadline.mjs'
import { downloadAttachment } from '../mail/read.mjs'
import { boundedBytes, check, encoder, fail, hex, safeName, sha256, textPrefix, validateMime } from './io.mjs'
import { parserFor, parseDocument } from './parsers.mjs'
import { hasSecret } from '../secrets.mjs'

const MiB = 1024*1024
const tables = [
  'CREATE TABLE IF NOT EXISTS maco_asset_identity (singleton INTEGER PRIMARY KEY, owner TEXT NOT NULL, epoch INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS maco_assets (id TEXT PRIMARY KEY, state TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS maco_assets_due ON maco_assets(state,due)',
  'CREATE TABLE IF NOT EXISTS maco_asset_put_keys (key TEXT PRIMARY KEY, digest TEXT NOT NULL, asset_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS maco_asset_parses (id TEXT PRIMARY KEY, state TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS maco_asset_parses_due ON maco_asset_parses(state,due)',
  'CREATE TABLE IF NOT EXISTS maco_asset_parse_cache (cache_key TEXT PRIMARY KEY, job_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS maco_asset_cleanup (object_key TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL)',
]
const setting = (value,fallback,min,max) => {
  const n = value === undefined ? fallback : Number(value)
  check(Number.isSafeInteger(n) && n >= min && n <= max,'invalid_asset_configuration',500)
  return n
}
const idFor = value => {
  check(typeof value === 'string' && /^asset_[a-f0-9-]{36}$/.test(value),'invalid_asset_id',400)
  return value
}
const optionalString = (value,max = 2048) => {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value),'invalid_asset_source',400)
  return value
}

function sourceValue(source,taskId) {
  if (source === undefined) return {kind:'upload'}
  check(source && typeof source === 'object' && !Array.isArray(source),'invalid_asset_source',400)
  const allowed = {upload:['kind'],mail:['kind','mailboxId','messageId','attachmentId','epoch','version'],
    executor:['kind','taskId','executionId','artifactId']}
  check(allowed[source.kind] && Object.keys(source).every(key => allowed[source.kind].includes(key)),'invalid_asset_source',400)
  if (source.kind === 'upload') return {kind:'upload'}
  if (source.kind === 'mail') {
    check(Number.isSafeInteger(source.epoch) && source.epoch >= 1,'invalid_asset_source',400)
    return {kind:'mail',mailboxId:identifier(source.mailboxId,'mailbox'),messageId:optionalString(source.messageId),
      attachmentId:optionalString(source.attachmentId),epoch:source.epoch,
      ...(source.version === undefined ? {} : {version:optionalString(source.version)})}
  }
  const result = {kind:'executor',taskId:identifier(source.taskId,'task')}
  check(taskId === result.taskId,'asset_task_mismatch',403)
  for (const key of ['executionId','artifactId']) if (source[key] !== undefined) result[key] = optionalString(source[key])
  return result
}

/** One instance belongs to exactly one authenticated user Durable Object.
 * ownerId is supplied by the server (normally ctx.id.toString()), never by an
 * upload body. R2 object keys are internal and never accepted from clients.
 */
export class AssetService {
  constructor(store,env,{ownerId,mail,fetcher = fetch,assertCurrent = () => {},maxBytes,maxRefs,maxParsedBytes,
    maxFiles,maxAccountBytes,clock = Date.now} = {}) {
    check(typeof ownerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ownerId),'asset_owner_required',500)
    Object.assign(this,{store,env,ownerId,mail,fetcher,assertCurrent,clock})
    this.prefix = 'accounts/'+ownerId+'/assets/'
    this.maxBytes = setting(maxBytes ?? env.ASSET_MAX_BYTES,10*MiB,1,32*MiB)
    this.maxRefs = setting(maxRefs ?? env.ASSET_MAX_REFS,4,1,16)
    this.maxParsedBytes = setting(maxParsedBytes ?? env.ASSET_MAX_PARSED_BYTES,2*MiB,4096,8*MiB)
    this.maxFiles = setting(maxFiles ?? env.ASSET_MAX_FILES,2048,1,100000)
    this.maxAccountBytes = setting(maxAccountBytes ?? env.ASSET_MAX_ACCOUNT_BYTES,256*MiB,this.maxBytes,100*1024*MiB)
    this.uploads = new Map()
    this.uploadControllers = new Set()
    this.parsers = new Map()
    this.buffering = 0
    store.tx(() => {
      for (const sql of tables) store.rows(sql)
      store.rows('INSERT OR IGNORE INTO maco_asset_identity VALUES (1,?,1)',ownerId)
      check(store.one('SELECT owner FROM maco_asset_identity WHERE singleton=1').owner === ownerId,'asset_owner_mismatch',500)
    })
  }
  epoch() { return this.store.one('SELECT epoch FROM maco_asset_identity WHERE singleton=1').epoch }
  capabilities() {
    return {enabled:Boolean(this.env.ASSETS),limits:{maxBytes:this.maxBytes,maxRefs:this.maxRefs,
      maxParsedBytes:this.maxParsedBytes,maxFiles:this.maxFiles,maxAccountBytes:this.maxAccountBytes},
      parsers:{local:true,cloudflare:typeof this.env.AI?.toMarkdown === 'function',
        deepseek:hasSecret(this.env.DEEPSEEK_OCR_API_KEY)},
      automaticOCR:this.env.ASSET_AUTO_OCR === 'deepseek' ? 'deepseek' : null}
  }
  cleanupStatus() {
    const pending = this.store.one('SELECT COUNT(*) AS count FROM maco_asset_cleanup').count
    const activeUploads = Math.max(this.uploads.size,this.buffering)
    const activeParses = this.parsers.size
    return {pending,activeUploads,activeParses,complete:pending === 0 && activeUploads === 0 && activeParses === 0}
  }
  #bucket() { check(this.env.ASSETS && typeof this.env.ASSETS.put === 'function','assets_not_configured',503); return this.env.ASSETS }
  #record(id) {
    const row = this.store.one('SELECT data FROM maco_assets WHERE id=?',idFor(id))
    check(row,'asset_not_found',404)
    return JSON.parse(row.data)
  }
  #job(id) {
    const row = this.store.one('SELECT data FROM maco_asset_parses WHERE id=?',id)
    return row ? JSON.parse(row.data) : null
  }
  #source(source) {
    this.assertCurrent()
    if (source.kind === 'mail') {
      check(this.mail && typeof this.mail.metadata === 'function','mailbox_unavailable',403)
      this.mail.metadata(source.mailboxId,source.epoch)
    }
  }
  #current(asset) {
    this.#source(asset.source)
    const current = this.#record(asset.id)
    check(current.state === 'ready','asset_not_available',current.state === 'deleted' ? 410 : 409)
    check(current.version === asset.version && current.controlEpoch === this.epoch(),'asset_changed',409)
    return current
  }
  #jobView(job) {
    if (!job) return null
    return {id:job.id,assetId:job.assetId,state:job.state,parser:job.options.parser,parserVersion:job.options.version,
      coverage:job.result?.coverage || 'unverified',warnings:job.result?.warnings || [],error:job.error || null,
      createdAt:job.createdAt,updatedAt:job.updatedAt,attempts:job.attempts,
      retryAfter:job.state === 'unknown' ? job.deadlineAt : job.state === 'queued' ? job.due : null,
      ...(job.result ? {pageCount:job.result.pageCount,usage:job.result.usage ?? null,
        coverageMeaning:job.result.coverageMeaning || 'extraction_coverage'} : {})}
  }
  #view(asset) {
    const parse = asset.parseId ? this.#jobView(this.#job(asset.parseId)) : null
    return {id:asset.id,name:asset.name,mimeType:asset.mimeType,size:asset.size,sha256:asset.sha256,
      createdAt:asset.createdAt,taskId:asset.taskId || null,source:asset.source,state:asset.state,
      parseStatus:parse?.state || 'not_requested',coverage:parse?.coverage || 'unverified',parse}
  }
  #save(asset,announce = true) {
    this.store.rows('INSERT INTO maco_assets VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      asset.id,asset.state,asset.due || 0,JSON.stringify(asset))
    if (announce) this.store.event('asset.updated',{asset:this.#view(asset)})
  }
  #saveJob(job) {
    job.updatedAt = this.clock()
    this.store.rows('INSERT INTO maco_asset_parses VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,data=excluded.data',
      job.id,job.state,job.due || 0,JSON.stringify(job))
    this.store.event('asset.parse.updated',{job:this.#jobView(job)})
  }
  #cleanupKey(key,due = this.clock()) {
    check(typeof key === 'string' && key.startsWith(this.prefix),'asset_key_mismatch',500)
    this.store.rows('INSERT INTO maco_asset_cleanup VALUES (?,?,0) ON CONFLICT(object_key) DO UPDATE SET due=MIN(due,excluded.due)',key,due)
  }
  #deferCleanup(key) {
    check(typeof key === 'string' && key.startsWith(this.prefix),'asset_key_mismatch',500)
    // An R2 request can outlive the isolate that lost its response. Keep the
    // deletion intent through the same quarantine used by upload recovery.
    this.store.rows('INSERT INTO maco_asset_cleanup VALUES (?,?,0) ON CONFLICT(object_key) DO UPDATE SET due=MAX(due,excluded.due)',
      key,this.clock()+180000)
  }
  #retireParse(id) {
    if (!id || this.store.one("SELECT id FROM maco_assets WHERE state='ready' AND json_extract(data,'$.parseId')=? LIMIT 1",id)) return
    const job = this.#job(id)
    if (!job) return
    const untrackedWrite = job.state === 'persisting' && !this.parsers.has(job.id)
    job.state = 'cancelled'; job.error = 'asset_not_referenced'; this.#saveJob(job)
    if (job.output) { if (untrackedWrite) this.#deferCleanup(job.output.key); else this.#cleanupKey(job.output.key) }
    this.parsers.get(job.id)?.abort()
  }
  #objectMatches(object,record) {
    check(object && object.key === record.key && object.size === record.size && object.customMetadata?.sha256 === record.sha256,
      'asset_integrity_error',502)
    if (object.checksums?.sha256) check(hex(object.checksums.sha256) === record.sha256,'asset_integrity_error',502)
  }
  get(id) {
    const record = this.#record(id)
    this.#current(record)
    return this.#view(record)
  }
  list({limit = 50,before = Number.MAX_SAFE_INTEGER,taskId} = {}) {
    this.assertCurrent()
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(before) && before > 0,'invalid_asset_page',400)
    if (taskId !== undefined) identifier(taskId,'task')
    const rows = this.store.rows(`SELECT rowid AS n,data FROM maco_assets WHERE state='ready' AND rowid<?
      ${taskId === undefined ? '' : "AND json_extract(data,'$.taskId')=?"} ORDER BY rowid DESC LIMIT ?`,
      ...[before,...(taskId === undefined ? [] : [taskId]),limit+1])
    const assets = []
    for (const row of rows.slice(0,limit)) {
      try { const asset = JSON.parse(row.data); this.#current(asset); assets.push(this.#view(asset)) }
      catch (error) { if (![403,409,410].includes(error.status)) throw error }
    }
    return {assets,nextBefore:rows.length > limit ? rows[limit-1].n : null}
  }
  validateRefs(ids) {
    check(Array.isArray(ids) && ids.length <= this.maxRefs && new Set(ids).size === ids.length,'invalid_asset_references',400)
    return ids.map(id => this.get(id))
  }
  async put(input = {}) {
    check(this.buffering < 1,'asset_upload_busy',429)
    const controller = new AbortController()
    const signal = input.signal ? AbortSignal.any([input.signal,controller.signal]) : controller.signal
    this.uploadControllers.add(controller)
    this.buffering++
    try { return await this.#put({...input,signal}) }
    finally { this.buffering--; this.uploadControllers.delete(controller) }
  }
  async #put({name,mimeType = 'application/octet-stream',body,size,expectedSha256,taskId,source,idempotencyKey,signal,assertAuthorized = () => {}}) {
    const bucket = this.#bucket()
    name = safeName(name)
    if (taskId !== undefined) identifier(taskId,'task')
    source = sourceValue(source,taskId)
    assertAuthorized(); this.#source(source)
    if (idempotencyKey !== undefined) optionalString(idempotencyKey,512)
    if (expectedSha256 !== undefined) check(typeof expectedSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(expectedSha256),'invalid_asset_digest',400)
    const controlEpoch = this.epoch()
    const current = () => { signal?.throwIfAborted(); assertAuthorized(); this.#source(source); check(this.epoch() === controlEpoch,'asset_changed',409) }
    const bytes = await boundedBytes(body,this.maxBytes,{size,signal,assertCurrent:current})
    check(bytes.length > 0,'asset_empty',400)
    mimeType = validateMime(bytes,name,mimeType)
    const digest = await sha256(bytes)
    current()
    if (expectedSha256 !== undefined) check(digest === expectedSha256.toLowerCase(),'asset_digest_mismatch',400)
    const requestDigest = await fingerprint({name,mimeType,size:bytes.length,sha256:digest,taskId:taskId || null,source})
    current()
    let asset
    this.store.tx(() => {
      const prior = idempotencyKey === undefined ? null : this.store.one('SELECT digest,asset_id FROM maco_asset_put_keys WHERE key=?',idempotencyKey)
      if (prior) {
        check(prior.digest === requestDigest,'asset_idempotency_conflict',409)
        asset = this.#record(prior.asset_id)
        check(asset.state !== 'deleted' && asset.controlEpoch === controlEpoch,'asset_deleted',410)
        if (asset.state === 'ready') return
      } else {
        const totals = this.store.one("SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(data,'$.size')),0) AS bytes FROM maco_assets WHERE state IN ('ready','uploading')")
        check(totals.count < this.maxFiles && totals.bytes + bytes.length <= this.maxAccountBytes,'asset_account_limit',413)
        const id = 'asset_'+crypto.randomUUID()
        asset = {id,key:this.prefix+'original/'+id,name,mimeType,size:bytes.length,sha256:digest,
          taskId:taskId || null,source,createdAt:this.clock(),state:'uploading',due:this.clock()+30000,version:1,controlEpoch}
        if (idempotencyKey !== undefined) this.store.rows('INSERT INTO maco_asset_put_keys VALUES (?,?,?)',idempotencyKey,requestDigest,id)
      }
      asset.state = 'uploading'; asset.due = this.clock()+30000
      this.store.rows('DELETE FROM maco_asset_cleanup WHERE object_key=?',asset.key)
      this.#save(asset,false)
    })
    if (asset.state === 'ready') { this.#current(asset); return this.#view(asset) }
    if (this.uploads.has(asset.id)) return this.uploads.get(asset.id)
    const operation = (async () => {
      let stored = false
      try {
        current()
        const object = await bucket.put(asset.key,bytes,{sha256:digest,httpMetadata:{contentType:mimeType},
          customMetadata:{sha256:digest,assetId:asset.id}})
        stored = true
        this.#objectMatches(object,asset)
        current()
        const latest = this.#record(asset.id)
        check(latest.state === 'uploading' && latest.version === asset.version,'asset_changed',409)
        asset.state = 'ready'; asset.due = 0
        this.store.tx(() => this.#save(asset))
        return this.#view(asset)
      } catch (error) {
        let latest = this.#record(asset.id)
        try { current() }
        catch {
          // An upload whose caller lost authority must never be published by
          // recovery. Tombstone it even if R2 committed before revocation.
          if (latest.state !== 'deleted') this.#remove(asset.id)
          latest = this.#record(asset.id)
        }
        if (latest.state === 'deleted' || latest.controlEpoch !== this.epoch()) {
          if (stored) this.#cleanupKey(asset.key)
          else this.#deferCleanup(asset.key)
        }
        // Keep a persisted upload intent when the R2 outcome is ambiguous.
        // A retry with the same idempotency key writes the same immutable bytes.
        throw error
      } finally { this.uploads.delete(asset.id) }
    })()
    this.uploads.set(asset.id,operation)
    return operation
  }
  async bytes(id,{maxBytes = this.maxBytes,signal,assertAuthorized = () => {}} = {}) {
    const record = this.#record(id)
    const current = () => { signal?.throwIfAborted(); assertAuthorized(); this.#current(record) }
    current()
    check(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && record.size <= Math.min(maxBytes,this.maxBytes),'asset_too_large',413)
    const object = await this.#bucket().get(record.key)
    current()
    this.#objectMatches(object,record)
    const bytes = await boundedBytes(object.body,maxBytes,{size:record.size,signal,assertCurrent:current})
    check(await sha256(bytes) === record.sha256,'asset_integrity_error',502)
    current()
    return {asset:this.#view(record),bytes}
  }
  async download(id,{signal,assertAuthorized = () => {}} = {}) {
    const record = this.#record(id)
    const validate = () => { signal?.throwIfAborted(); assertAuthorized(); this.#current(record) }
    validate()
    const object = await this.#bucket().get(record.key)
    validate(); this.#objectMatches(object,record)
    check(object.body && typeof object.body.getReader === 'function','asset_integrity_error',502)
    const reader = object.body.getReader()
    let length = 0
    const body = new ReadableStream({
      async pull(controller) {
        try {
          validate()
          const {value,done} = await reader.read()
          validate()
          if (done) { check(length === record.size,'asset_integrity_error',502); reader.releaseLock(); controller.close(); return }
          check(value instanceof Uint8Array,'asset_integrity_error',502)
          length += value.byteLength
          check(length <= record.size,'asset_integrity_error',502)
          controller.enqueue(value)
        } catch (error) { try { await reader.cancel(error) } catch {}; controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { reader.releaseLock() } },
    })
    return {asset:this.#view(record),body}
  }
  async importMail({mailboxId,messageId,attachmentId,expectedEpoch,version,taskId,signal,assertAuthorized = () => {}} = {}) {
    assertAuthorized()
    check(this.mail,'mailbox_unavailable',403)
    const meta = this.mail.metadata(identifier(mailboxId,'mailbox'),expectedEpoch)
    const context = await this.mail.context(mailboxId,meta.epoch)
    const current = () => { assertAuthorized(); this.assertCurrent(); this.mail.metadata(mailboxId,meta.epoch); signal?.throwIfAborted() }
    current()
    const input = {mailboxId,messageId,attachmentId,...(version === undefined ? {} : {version})}
    let downloaded
    try { downloaded = await downloadAttachment({...context,fetchImpl:(...args) => { current(); return this.fetcher(...args) },signal},input,this.maxBytes) }
    catch (error) { current(); throw error }
    const {ref,bytes} = downloaded
    current()
    const source = {kind:'mail',mailboxId,messageId:ref.messageId,attachmentId:ref.attachmentId,epoch:meta.epoch,
      ...(ref.version === undefined ? {} : {version:ref.version})}
    const idempotencyKey = 'mail:'+await fingerprint({source,sha256:await sha256(bytes),taskId:taskId || null})
    current()
    return this.put({name:ref.name,mimeType:ref.mimeType,body:bytes,size:bytes.length,source,taskId,idempotencyKey,signal,assertAuthorized})
  }
  parse(id,options = {}) {
    const asset = this.#record(id)
    this.#current(asset)
    const selected = parserFor(asset,this.env,options)
    for (const key of ['force','allowRetryUnknown']) if (options[key] !== undefined) check(typeof options[key] === 'boolean','invalid_parse_options',400)
    let job
    this.store.tx(() => {
      const cached = this.store.one('SELECT job_id FROM maco_asset_parse_cache WHERE cache_key=?',selected.cacheKey)
      job = cached ? this.#job(cached.job_id) : null
      if (job?.state === 'unknown' && options.force) {
        check(options.allowRetryUnknown === true && this.clock() >= job.deadlineAt,'parse_result_unknown',409)
      }
      const reuse = job && (['queued','running','persisting'].includes(job.state) || (!options.force && job.state !== 'cancelled'))
      if (!reuse) {
        const pending = this.store.one("SELECT COUNT(*) AS count FROM maco_asset_parses WHERE state IN ('queued','running','persisting')").count
        check(pending < 16,'asset_parse_capacity',429)
        job = {id:'parse_'+crypto.randomUUID(),assetId:asset.id,state:'queued',due:this.clock(),options:selected,
          controlEpoch:this.epoch(),attempts:0,createdAt:this.clock(),updatedAt:this.clock(),error:null}
        this.#saveJob(job)
        this.store.rows('INSERT INTO maco_asset_parse_cache VALUES (?,?) ON CONFLICT(cache_key) DO UPDATE SET job_id=excluded.job_id',selected.cacheKey,job.id)
      }
      const previous = asset.parseId
      asset.parseId = job.id
      this.#save(asset)
      if (previous !== job.id) this.#retireParse(previous)
    })
    return this.#jobView(job)
  }
  parseJob(id) {
    const job = this.#job(id)
    check(job,'parse_job_not_found',404)
    this.#chooseAsset(job)
    return this.#jobView(job)
  }
  #chooseAsset(job) {
    const candidates = this.store.rows("SELECT data FROM maco_assets WHERE state='ready' AND json_extract(data,'$.parseId')=? ORDER BY rowid LIMIT 2048",job.id)
    for (const {data} of candidates) {
      const asset = JSON.parse(data)
      try { this.#current(asset); return asset } catch (error) { if (![403,409,410].includes(error.status)) throw error }
    }
    throw fail('asset_not_available',410)
  }
  async #parsed(id) {
    const asset = this.#record(id)
    this.#current(asset)
    if (!asset.parseId) return {asset:this.#view(asset),job:this.parse(id),pending:true}
    const job = this.#job(asset.parseId)
    check(job,'parse_job_not_found',404)
    if (job.state !== 'succeeded') return {asset:this.#view(asset),job:this.#jobView(job),pending:['queued','running','persisting'].includes(job.state)}
    const object = await this.#bucket().get(job.output.key)
    this.#current(asset)
    this.#objectMatches(object,job.output)
    const bytes = await boundedBytes(object.body,this.maxParsedBytes,{size:job.output.size,assertCurrent:() => this.#current(asset)})
    check(await sha256(bytes) === job.output.sha256,'asset_integrity_error',502)
    let parsed
    try { parsed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) } catch { throw fail('asset_integrity_error',502) }
    check(parsed?.schemaVersion === 1 && parsed.sourceSha256 === asset.sha256 && Array.isArray(parsed.pages),'asset_integrity_error',502)
    return {asset:this.#view(asset),job:this.#jobView(job),parsed}
  }
  async read(id,{page,offset = 0,maxBytes = 48*1024} = {}) {
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 48*1024,'invalid_asset_range',400)
    if (page !== undefined) check(Number.isSafeInteger(page) && page >= 1,'invalid_asset_page',400)
    const result = await this.#parsed(id)
    if (!result.parsed) return {...result,coverage:'unverified'}
    const {parsed,asset,job} = result
    const selected = page === undefined ? parsed.pages : parsed.pages.filter(item => item.page === page)
    if (page !== undefined) check(selected.length > 0,'asset_page_unavailable',404)
    const text = selected.map(item => item.text).join('\n\n')
    check(offset <= text.length,'invalid_asset_range',400)
    const clipped = textPrefix(text.slice(offset),maxBytes)
    return {asset,job,format:parsed.format,coverage:parsed.coverage,warnings:parsed.warnings,
      page:page ?? null,text:clipped.text,offset,nextOffset:clipped.truncated ? offset+clipped.text.length : null,
      pageCount:parsed.pages.length,rangeTruncated:clipped.truncated,coverageMeaning:parsed.coverageMeaning || 'extraction_coverage'}
  }
  async search(id,{query,limit = 8} = {}) {
    check(typeof query === 'string' && query.trim() && query.length <= 500 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 20,'invalid_asset_query',400)
    const result = await this.#parsed(id)
    if (!result.parsed) return {...result,coverage:'unverified',matches:[]}
    const queryText = query.toLocaleLowerCase(),matches = []
    let more = false
    for (const page of result.parsed.pages) {
      const lower = page.text.toLocaleLowerCase()
      let start = 0
      for (;;) {
        const index = lower.indexOf(queryText,start)
        if (index < 0) break
        if (matches.length >= limit) { more = true; break }
        const from = Math.max(0,index-180),to = Math.min(page.text.length,index+query.length+360)
        matches.push({page:page.page,offset:index,text:page.text.slice(from,to),truncated:from > 0 || to < page.text.length})
        start = index+Math.max(1,queryText.length)
      }
      if (more) break
    }
    return {asset:result.asset,job:result.job,coverage:result.parsed.coverage,warnings:result.parsed.warnings,matches,hasMore:more}
  }
  remove(id) {
    this.assertCurrent()
    return this.retire(id)
  }
  // Trusted executor/lifecycle cleanup; never exposed as a user mutation.
  retire(id) {
    check(this.store.one('SELECT owner FROM maco_asset_identity WHERE singleton=1')?.owner === this.ownerId,'asset_owner_mismatch',500)
    return this.#remove(id)
  }
  #remove(id) {
    const row = this.store.one('SELECT data FROM maco_assets WHERE id=?',idFor(id))
    if (!row) return {removed:false}
    const asset = JSON.parse(row.data)
    if (asset.state === 'deleted') return {removed:true}
    const untrackedWrite = asset.state === 'uploading' && !this.uploads.has(asset.id)
    this.store.tx(() => {
      asset.state = 'deleted'; asset.version++; asset.due = 0
      this.#save(asset)
      if (untrackedWrite) this.#deferCleanup(asset.key)
      else this.#cleanupKey(asset.key)
      this.#retireParse(asset.parseId)
    })
    return {removed:true,cleanupPending:true}
  }
  removeAll() {
    this.assertCurrent()
    return this.erase()
  }
  /** Trusted lifecycle-only teardown. The account is already fenced before
   * this is invoked, so the active-account guard must not block cleanup. No
   * client route exposes this method. Identity and idempotency tombstones stay.
   */
  erase() {
    check(this.store.one('SELECT owner FROM maco_asset_identity WHERE singleton=1')?.owner === this.ownerId,'asset_owner_mismatch',500)
    const ids = this.store.rows("SELECT id FROM maco_assets WHERE state<>'deleted'").map(row => row.id)
    this.store.tx(() => {
      this.store.rows('UPDATE maco_asset_identity SET epoch=epoch+1 WHERE singleton=1')
      for (const id of ids) this.#remove(id)
    })
    for (const controller of this.uploadControllers) controller.abort(fail('asset_changed',409))
    for (const controller of this.parsers.values()) controller.abort(fail('parse_superseded',409))
    return {removed:ids.length,cleanupPending:this.store.one('SELECT COUNT(*) AS count FROM maco_asset_cleanup').count > 0}
  }
  /** Remove file metadata only after account teardown has drained every R2
   * write/delete. Durable ID and request tombstones prohibit stale replays.
   */
  purgeRetired() {
    check(this.store.one('SELECT owner FROM maco_asset_identity WHERE singleton=1')?.owner === this.ownerId,'asset_owner_mismatch',500)
    check(this.cleanupStatus().complete && !this.store.one("SELECT id FROM maco_assets WHERE state<>'deleted' LIMIT 1"),
      'asset_cleanup_incomplete',409)
    return this.store.tx(() => {
      const records = this.store.rows('SELECT data FROM maco_assets')
      for (const {data} of records) {
        const asset = JSON.parse(data)
        this.#save({id:asset.id,state:'deleted',version:asset.version,controlEpoch:asset.controlEpoch,
          source:{kind:'upload'},due:0},false)
      }
      this.store.rows('DELETE FROM maco_asset_parse_cache')
      this.store.rows('DELETE FROM maco_asset_parses')
      return {purged:records.length}
    })
  }
  recover() {
    // Called synchronously from the account scheduler's recovery transaction.
    for (const {data} of this.store.rows("SELECT data FROM maco_assets WHERE state='uploading'")) {
      const asset = JSON.parse(data); asset.due = 0; this.#save(asset,false)
    }
    for (const {data} of this.store.rows("SELECT data FROM maco_asset_parses WHERE state='running'")) {
      const job = JSON.parse(data)
      // Older running records lack this flag and must stay conservative. A
      // current attempt waiting for a secret has not dispatched billable OCR.
      if (job.options.parser === 'deepseek' && job.dispatched !== false) { job.state = 'unknown'; job.error = 'ocr_completion_unknown' }
      else if (job.attempts < 3) { job.state = 'queued'; job.due = 0; job.error = 'parse_interrupted' }
      else { job.state = 'failed'; job.error = 'parse_interrupted' }
      this.#saveJob(job)
    }
  }
  nextDue() {
    const values = this.store.rows("SELECT id,due FROM maco_assets WHERE state='uploading'").filter(row => !this.uploads.has(row.id)).map(row => row.due)
    const other = this.store.one("SELECT MIN(due) AS due FROM (SELECT due FROM maco_asset_parses WHERE state IN ('queued','persisting') UNION ALL SELECT due FROM maco_asset_cleanup)").due
    if (other !== null && other !== undefined) values.push(other)
    return values.length ? Math.min(...values) : null
  }
  #inUse(key) {
    if (this.store.one("SELECT id FROM maco_assets WHERE state IN ('ready','uploading') AND json_extract(data,'$.key')=? LIMIT 1",key)) return true
    return Boolean(this.store.one(`SELECT p.id FROM maco_asset_parses p WHERE p.state IN ('succeeded','persisting')
      AND json_extract(p.data,'$.output.key')=? AND EXISTS
      (SELECT 1 FROM maco_assets a WHERE a.state='ready' AND json_extract(a.data,'$.parseId')=p.id) LIMIT 1`,key))
  }
  async cleanup({limit = 8,signal} = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,'invalid_cleanup_limit',400)
    let removed = 0
    for (const row of this.store.rows('SELECT object_key,due,attempts FROM maco_asset_cleanup WHERE due<=? ORDER BY due LIMIT ?',this.clock(),limit)) {
      signal?.throwIfAborted()
      if (this.#inUse(row.object_key)) { this.store.rows('DELETE FROM maco_asset_cleanup WHERE object_key=?',row.object_key); continue }
      try {
        await this.#bucket().delete(row.object_key)
        this.store.rows('DELETE FROM maco_asset_cleanup WHERE object_key=?',row.object_key)
        removed++
      } catch {
        this.store.rows('UPDATE maco_asset_cleanup SET due=?,attempts=attempts+1 WHERE object_key=?',
          this.clock()+Math.min(300000,5000*2**Math.min(row.attempts,6)),row.object_key)
      }
    }
    return {removed,...this.cleanupStatus()}
  }
  async #recoverUpload(asset) {
    try {
      const object = await this.#bucket().head(asset.key)
      const latest = this.#record(asset.id)
      if (latest.state !== 'uploading') { if (object && latest.state === 'deleted') this.#cleanupKey(asset.key); return }
      if (object) {
        this.#objectMatches(object,asset)
        this.#source(asset.source)
        check(asset.controlEpoch === this.epoch(),'asset_changed',409)
        asset.state = 'ready'; asset.due = 0
      } else {
        asset.state = 'failed'; asset.due = 0
        // An old upload whose response was lost could still finish. A caller's
        // idempotent retry can reuse the same key; cleanup skips live records.
        this.#cleanupKey(asset.key,this.clock()+180000)
      }
      this.store.tx(() => this.#save(asset))
    } catch (error) {
      if ([403,409,410].includes(error.status)) { this.remove(asset.id); return }
      if (error.code === 'asset_integrity_error') {
        asset.state = 'failed'; asset.due = 0; this.#cleanupKey(asset.key); this.#save(asset); return
      }
      asset.due = this.clock()+30000; this.#save(asset,false)
    }
  }
  async #recoverOutput(job) {
    try {
      const object = await this.#bucket().head(job.output.key)
      const latest = this.#job(job.id)
      if (latest?.state !== 'persisting') { if (object) this.#cleanupKey(job.output.key); return }
      this.#chooseAsset(job)
      if (object) { this.#objectMatches(object,job.output); job.state = 'succeeded'; job.error = null }
      else { job.state = 'failed'; job.error = 'parsed_output_missing'; this.#cleanupKey(job.output.key,this.clock()+180000) }
      job.due = 0; this.#saveJob(job)
    } catch (error) {
      if ([403,409,410].includes(error.status)) { job.state = 'cancelled'; job.error = 'asset_not_available'; this.#cleanupKey(job.output.key) }
      else if (error.code === 'asset_integrity_error') { job.state = 'failed'; job.error = error.code; this.#cleanupKey(job.output.key) }
      else job.due = this.clock()+30000
      this.#saveJob(job)
    }
  }
  async runNext(signalOrOptions) {
    const signal = signalOrOptions?.addEventListener ? signalOrOptions : signalOrOptions?.signal
    signal?.throwIfAborted()
    const upload = this.store.rows("SELECT id,data FROM maco_assets WHERE state='uploading' AND due<=? ORDER BY due LIMIT 16",this.clock()).find(row => !this.uploads.has(row.id))
    if (upload) { await this.#recoverUpload(JSON.parse(upload.data)); return {worked:true,kind:'upload_recovery'} }
    if (this.store.one('SELECT object_key FROM maco_asset_cleanup WHERE due<=? LIMIT 1',this.clock())) {
      await this.cleanup({signal}); return {worked:true,kind:'cleanup'}
    }
    if (this.parsers.size) return {worked:false}
    const row = this.store.one("SELECT data FROM maco_asset_parses WHERE state IN ('queued','persisting') AND due<=? ORDER BY due,rowid LIMIT 1",this.clock())
    if (!row) return {worked:false}
    const job = JSON.parse(row.data)
    if (job.state === 'persisting') { await this.#recoverOutput(job); return {worked:true,job:this.#jobView(this.#job(job.id))} }
    let asset
    try { asset = this.#chooseAsset(job) }
    catch (error) { job.state = 'cancelled'; job.error = errorCode(error,'asset_not_available'); this.#saveJob(job); return {worked:true,job:this.#jobView(job)} }
    const controller = new AbortController()
    this.parsers.set(job.id,controller)
    const parentSignal = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal
    job.state = 'running'; job.attempts++; job.error = null; job.attemptId = crypto.randomUUID(); job.startedAt = this.clock(); job.dispatched = false
    job.deadlineAt = this.clock()+(job.options.parser === 'deepseek' ? 180000 : 60000)
    this.#saveJob(job)
    const current = () => {
      parentSignal.throwIfAborted()
      const now = this.#job(job.id)
      check(now?.state === 'running' && now.attemptId === job.attemptId && job.controlEpoch === this.epoch(),'parse_superseded',409)
      this.#current(asset)
    }
    let stored = false
    try {
      const {bytes} = await this.bytes(asset.id,{signal:parentSignal})
      current()
      const parsed = await withDeadline(job.options.parser === 'deepseek' ? 180000 : 60000,parentSignal,deadline =>
        parseDocument({...asset,parseOptions:job.options},bytes,this.env,{
          signal:deadline,fetcher:this.fetcher,assertCurrent:current,
          onDispatch:() => { current(); job.dispatched = true; job.deadlineAt = this.clock()+180000; this.#saveJob(job) },
          maxTextBytes:this.maxParsedBytes-Math.min(256*1024,Math.floor(this.maxParsedBytes/4)),
          maxResponseBytes:Math.min(16*MiB,this.maxParsedBytes*4),maxPages:1000,
        }))
      current()
      const resultBytes = encoder.encode(JSON.stringify(parsed))
      check(resultBytes.length <= this.maxParsedBytes,'parsed_output_too_large',413)
      const digest = await sha256(resultBytes)
      current()
      job.output = {key:this.prefix+'parsed/'+job.id+'/'+job.attemptId,size:resultBytes.length,sha256:digest}
      job.result = {coverage:parsed.coverage,warnings:parsed.warnings,pageCount:parsed.pages.length,usage:parsed.usage,
        coverageMeaning:parsed.coverageMeaning || 'extraction_coverage'}
      job.state = 'persisting'; job.due = this.clock()+30000
      this.#saveJob(job)
      const object = await this.#bucket().put(job.output.key,resultBytes,{sha256:digest,httpMetadata:{contentType:'application/json'},customMetadata:{sha256:digest}})
      stored = true
      this.#objectMatches(object,job.output)
      this.#current(asset)
      const latest = this.#job(job.id)
      check(latest?.state === 'persisting' && latest.attemptId === job.attemptId && job.controlEpoch === this.epoch(),'parse_superseded',409)
      job.state = 'succeeded'; job.error = null; job.due = 0
      this.#saveJob(job)
    } catch (error) {
      const latest = this.#job(job.id)
      if (!latest || !['running','persisting'].includes(latest.state) || latest.attemptId !== job.attemptId) {
        if (job.output) { if (stored) this.#cleanupKey(job.output.key); else this.#deferCleanup(job.output.key) }
      } else if (latest.state === 'persisting') {
        // Persisted object intent makes a lost R2 response recoverable without
        // submitting the document to a potentially billable parser again.
        latest.due = this.clock()+5000; latest.error = 'parsed_output_pending'; this.#saveJob(latest)
      } else {
        const code = errorCode(error,parentSignal.aborted ? 'parse_interrupted' : 'attachment_parse_failed')
        if (code === 'parser_rate_limited' && job.attempts < 3) {
          job.state = 'queued'; job.due = this.clock()+(error.retryAfterMs || 30000)
        } else if (code === 'ocr_completion_unknown' || (job.options.parser === 'deepseek' && job.dispatched && (parentSignal.aborted || error?.name === 'TimeoutError'))) {
          job.state = 'unknown'; job.error = 'ocr_completion_unknown'
        } else job.state = 'failed'
        job.error ||= code
        if (job.state !== 'queued') job.due = 0
        this.#saveJob(job)
      }
    } finally { this.parsers.delete(job.id) }
    return {worked:true,job:this.#jobView(this.#job(job.id))}
  }
}

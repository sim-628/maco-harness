import { ApiError, requireThat } from '../protocol.mjs'

export const encoder = new TextEncoder()
export const fail = (code,status = 422) => new ApiError(status,code)
export const check = (condition,code,status = 422) => requireThat(condition,code,status)
export const hex = bytes => Array.from(new Uint8Array(bytes),n => n.toString(16).padStart(2,'0')).join('')
export const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256',bytes))

export function safeName(value) {
  check(typeof value === 'string' && value.trim() && encoder.encode(value).length <= 255 &&
    !/[\x00-\x1f\x7f/\\]/u.test(value) && !['.','..'].includes(value),'invalid_asset_name',400)
  return value.trim()
}

export function mime(value = 'application/octet-stream') {
  check(typeof value === 'string','invalid_asset_mime',400)
  const result = value.split(';',1)[0].trim().toLowerCase()
  check(result.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(result),'invalid_asset_mime',400)
  return result
}

export const TEXT_MIMES = new Set(['text/plain','text/markdown','text/csv','text/tab-separated-values',
  'application/json','application/xml','text/xml','text/html','application/xhtml+xml'])

const extTypes = {
  pdf:'application/pdf',txt:'text/plain',md:'text/markdown',markdown:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',
  json:'application/json',html:'text/html',htm:'text/html',xml:'application/xml',svg:'image/svg+xml',
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp',tif:'image/tiff',tiff:'image/tiff',
  doc:'application/msword',xls:'application/vnd.ms-excel',ppt:'application/vnd.ms-powerpoint',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm:'application/vnd.ms-excel.sheet.macroenabled.12',xlsb:'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ods:'application/vnd.oasis.opendocument.spreadsheet',odt:'application/vnd.oasis.opendocument.text',
  numbers:'application/vnd.apple.numbers',zip:'application/zip',
}
export const extension = name => /\.([a-z0-9]{1,12})$/i.exec(name)?.[1].toLowerCase() || ''
const zipTypes = new Set(['docx','xlsx','xlsm','xlsb','pptx','ods','odt','numbers','zip'].map(ext => extTypes[ext]))
const compoundTypes = new Set(['doc','xls','ppt'].map(ext => extTypes[ext]))
const matches = (bytes,signature,offset = 0) => signature.every((n,i) => bytes[offset+i] === n)

// MIME is a content gate, not a claim that an Office container was completely
// validated. We never decompress an untrusted archive in the Worker.
export function validateMime(bytes,name,declared) {
  let selected = mime(declared)
  const expected = extTypes[extension(name)]
  if (selected === 'application/octet-stream' && expected) selected = expected
  const zip = matches(bytes,[0x50,0x4b,3,4]) || matches(bytes,[0x50,0x4b,5,6])
  const compound = matches(bytes,[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])
  const signatures = [
    ['application/pdf',matches(bytes,[0x25,0x50,0x44,0x46,0x2d])],
    ['image/png',matches(bytes,[137,80,78,71,13,10,26,10])],
    ['image/jpeg',matches(bytes,[255,216,255])],
    ['image/gif',matches(bytes,[71,73,70,56,55,97]) || matches(bytes,[71,73,70,56,57,97])],
    ['image/webp',matches(bytes,[82,73,70,70]) && matches(bytes,[87,69,66,80],8)],
    ['image/bmp',matches(bytes,[66,77])],
    ['image/tiff',matches(bytes,[73,73,42,0]) || matches(bytes,[77,77,0,42])],
  ]
  const detected = signatures.find(([,present]) => present)?.[0]
  if (selected === 'application/octet-stream' && detected) selected = detected
  if (detected && selected !== detected) throw fail('asset_mime_mismatch')
  if (signatures.some(([type]) => type === selected) && detected !== selected) throw fail('asset_mime_mismatch')
  if (zipTypes.has(selected) && !zip) throw fail('asset_mime_mismatch')
  if (compoundTypes.has(selected) && !compound) throw fail('asset_mime_mismatch')
  if (TEXT_MIMES.has(selected) || selected === 'image/svg+xml') {
    check(!zip && !compound && !detected,'asset_mime_mismatch')
    const decoder = new TextDecoder('utf-8',{fatal:true})
    try {
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        check(!decoder.decode(bytes.subarray(offset,offset+16384),{stream:true}).includes('\u0000'),'asset_invalid_encoding')
      }
      decoder.decode()
    } catch (error) { throw error instanceof ApiError ? error : fail('asset_invalid_encoding') }
  }
  return selected
}

// This deliberately buffers only after enforcing the byte budget, before R2
// put. R2 requires a known-length stream; a user chunked stream has none. The
// service also bounds concurrent uploads so buffering cannot grow per request.
export async function boundedBytes(body,max,{size,signal,assertCurrent = () => {}} = {}) {
  check(Number.isSafeInteger(max) && max >= 0,'invalid_asset_limit',500)
  if (size !== undefined) check(Number.isSafeInteger(size) && size >= 0 && size <= max,'asset_too_large',413)
  signal?.throwIfAborted()
  let stream
  if (body instanceof Blob) stream = body.stream()
  else if (body instanceof ArrayBuffer) stream = new Blob([body]).stream()
  else if (ArrayBuffer.isView(body)) stream = new Blob([new Uint8Array(body.buffer,body.byteOffset,body.byteLength)]).stream()
  else if (typeof body === 'string') stream = new Blob([body]).stream()
  else if (body && typeof body.getReader === 'function') stream = body
  else throw fail('invalid_asset_body',400)
  const reader = stream.getReader()
  const chunks = []
  let length = 0
  const aborted = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort',aborted,{once:true})
  try {
    for (;;) {
      signal?.throwIfAborted(); assertCurrent()
      const {done,value} = await reader.read()
      signal?.throwIfAborted(); assertCurrent()
      if (done) break
      check(value instanceof Uint8Array,'invalid_asset_stream',400)
      length += value.byteLength
      check(length <= max,'asset_too_large',413)
      chunks.push(value)
    }
    if (size !== undefined) check(length === size,'asset_size_mismatch',400)
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength }
    return result
  } catch (error) {
    try { await reader.cancel(error) } catch {}
    throw error
  } finally { signal?.removeEventListener('abort',aborted); reader.releaseLock() }
}

export async function boundedJSON(response,max,signal) {
  const header = response.headers.get('Content-Length')
  const size = header !== null && /^\d+$/.test(header) ? Number(header) : undefined
  const bytes = await boundedBytes(response.body,max,{size,signal})
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) }
  catch { throw fail('invalid_parser_response',502) }
}

export function textPrefix(text,maxBytes) {
  check(typeof text === 'string','invalid_parser_response',502)
  const target = new Uint8Array(maxBytes)
  const {read,written} = encoder.encodeInto(text,target)
  return {text:new TextDecoder().decode(target.subarray(0,written)),bytes:written,truncated:read < text.length}
}

export function abortable(promise,signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve,reject) => {
    const abort = () => { signal.removeEventListener('abort',abort); reject(signal.reason) }
    signal.addEventListener('abort',abort,{once:true})
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort',abort); resolve(value) },
      error => { signal.removeEventListener('abort',abort); reject(error) })
  })
}

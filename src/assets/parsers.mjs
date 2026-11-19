import { TEXT_MIMES, abortable, boundedJSON, check, extension, fail, textPrefix } from './io.mjs'

export const PARSER_VERSION = 'maco-document-v1'
const cfExtensions = new Set(['pdf','docx','xlsx','xlsm','xlsb','xls','et','ods','odt','numbers'])
const ocrExtensions = new Set(['pdf','doc','docx','ppt','pptx','png','jpg','jpeg','webp','gif','bmp','tif','tiff'])
const namesByMime = {
  'application/pdf':'pdf','application/msword':'doc','application/vnd.ms-powerpoint':'ppt',
  'application/vnd.ms-excel':'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
  'application/vnd.ms-excel.sheet.macroenabled.12':'xlsm','application/vnd.ms-excel.sheet.binary.macroenabled.12':'xlsb',
  'application/vnd.oasis.opendocument.spreadsheet':'ods','application/vnd.oasis.opendocument.text':'odt',
  'application/vnd.apple.numbers':'numbers',
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/bmp':'bmp','image/tiff':'tiff',
}

export function parserFor(asset,env,options = {}) {
  check(options && typeof options === 'object' && !Array.isArray(options),'invalid_parse_options',400)
  check(Object.keys(options).every(key => ['parser','purpose','force','allowRetryUnknown'].includes(key)),'invalid_parse_options',400)
  const requested = options.parser || 'auto'
  check(['auto','local','cloudflare','deepseek'].includes(requested),'unsupported_parser',400)
  const purpose = options.purpose || 'text_recognition'
  check(['text_recognition','rich_layout_recognition'].includes(purpose),'invalid_ocr_purpose',400)
  const ext = namesByMime[asset.mimeType] || extension(asset.name)
  let parser = requested
  if (parser === 'auto') {
    if (TEXT_MIMES.has(asset.mimeType)) parser = 'local'
    else if (cfExtensions.has(ext) && !asset.mimeType.startsWith('image/')) parser = 'cloudflare'
    else if (ocrExtensions.has(ext) && env.ASSET_AUTO_OCR === 'deepseek') parser = 'deepseek'
    else throw fail(asset.mimeType.startsWith('image/') ? 'ocr_not_configured' : 'unsupported_attachment_type')
  }
  if (parser === 'local') check(TEXT_MIMES.has(asset.mimeType),'unsupported_attachment_type')
  if (parser === 'cloudflare') {
    check(cfExtensions.has(ext) && !asset.mimeType.startsWith('image/'),'unsupported_attachment_type')
    check(typeof env.AI?.toMarkdown === 'function','attachment_parser_not_configured',503)
  }
  if (parser === 'deepseek') {
    check(ocrExtensions.has(ext),'unsupported_attachment_type')
    check(typeof env.DEEPSEEK_OCR_API_KEY === 'string' && env.DEEPSEEK_OCR_API_KEY.length > 0 &&
      env.DEEPSEEK_OCR_API_KEY.length <= 16000 && !/[\x00-\x20\x7f]/.test(env.DEEPSEEK_OCR_API_KEY),'ocr_not_configured',503)
  }
  return {parser,version:PARSER_VERSION,purpose,extension:ext,
    // Adapter version, content, type and parsing policy form a per-user cache.
    cacheKey:[PARSER_VERSION,parser,asset.sha256,asset.mimeType,purpose].join(':')}
}

function usage(value) {
  if (!value || typeof value !== 'object') return null
  const result = {}
  for (const name of ['input_tokens','output_tokens','total_tokens']) {
    if (Number.isSafeInteger(value[name]) && value[name] >= 0) result[name] = value[name]
  }
  return Object.keys(result).length ? result : null
}

function local(asset,bytes,maxTextBytes) {
  const decoder = new TextDecoder('utf-8',{fatal:true})
  let text
  try { text = decoder.decode(bytes.subarray(0,maxTextBytes),{stream:bytes.length > maxTextBytes}) }
  catch { throw fail('asset_invalid_encoding') }
  check(!text.includes('\u0000'),'asset_invalid_encoding')
  const truncated = bytes.length > maxTextBytes
  return {format:asset.mimeType === 'text/markdown' ? 'markdown' : 'text',coverage:truncated ? 'partial' : 'complete',
    warnings:truncated ? ['text_output_truncated'] : [],pages:[{page:null,text,truncated}],usage:null}
}

async function cloudflare(asset,bytes,env,{maxTextBytes,signal,assertCurrent}) {
  // The live capability list can change independently of this adapter. It is
  // checked before each first conversion; cached parsed output needs no call.
  const utility = env.AI.toMarkdown()
  check(typeof utility?.supported === 'function','attachment_parser_unavailable',503)
  const supported = await abortable(utility.supported(),signal)
  check(Array.isArray(supported),'invalid_parser_response',502)
  const ext = namesByMime[asset.mimeType] || extension(asset.name)
  const matches = item => (typeof item?.extension === 'string' && item.extension.replace(/^\./,'').toLowerCase() === ext) ||
    (typeof item?.mimeType === 'string' && item.mimeType.toLowerCase() === asset.mimeType)
  check(supported.some(matches),'unsupported_attachment_type')
  assertCurrent()
  const value = await abortable(env.AI.toMarkdown({name:'attachment.'+ext,blob:new Blob([bytes],{type:asset.mimeType})},
    {conversionOptions:{pdf:{metadata:false},output:{format:'markdown'}}}),signal)
  assertCurrent()
  const result = Array.isArray(value) ? value.length === 1 ? value[0] : null : value
  check(result && ['markdown','text','error'].includes(result.format),'invalid_parser_response',502)
  check(result.format !== 'error','attachment_conversion_failed',422)
  const clipped = textPrefix(result.data,maxTextBytes)
  check(clipped.text.trim().length > 0,'attachment_no_text',422)
  return {format:result.format,coverage:clipped.truncated ? 'partial' : 'unverified',
    warnings:['coverage_not_verified',...(clipped.truncated ? ['text_output_truncated'] : []),
      ...(asset.mimeType === 'application/pdf' ? ['pdf_scanned_pages_may_be_missing'] : [])],
    pages:[{page:null,text:clipped.text,truncated:clipped.truncated}],usage:null}
}

// Strip only the documented location wrappers for neutral text. This adapter
// does not claim to preserve a full layout graph or extract cropped images.
function normalizeOCR(raw) {
  return raw.replace(/<｜box｜>[\s\S]*?<｜\/box｜>/gu,'')
    .replace(/<｜\/?ref｜>/gu,'')
}

async function deepseek(asset,bytes,env,{fetcher,maxTextBytes,maxResponseBytes,maxPages,signal,assertCurrent,onDispatch}) {
  const form = new FormData()
  form.set('file',new Blob([bytes],{type:asset.mimeType}),asset.name)
  form.set('purpose',asset.parseOptions.purpose)
  assertCurrent()
  onDispatch?.()
  let response
  try {
    response = await fetcher('https://api.deepseek.com/v1/tools/ocr',{
      method:'POST',headers:{Authorization:'Bearer '+env.DEEPSEEK_OCR_API_KEY},body:form,redirect:'manual',signal,
    })
  } catch { throw fail('ocr_completion_unknown',502) }
  if (!response.ok) {
    try { await response.body?.cancel() } catch {}
    if (response.status === 429 || response.status === 503) {
      const error = fail('parser_rate_limited',429)
      const retry = Number(response.headers.get('Retry-After'))
      error.retryAfterMs = Number.isFinite(retry) && retry > 0 ? Math.min(300000,retry*1000) : 30000
      throw error
    }
    if ([400,401,402,403,413].includes(response.status)) throw fail(response.status === 402 ? 'ocr_balance_required' : 'ocr_rejected',422)
    throw fail('ocr_completion_unknown',502)
  }
  let result
  try { result = await boundedJSON(response,maxResponseBytes,signal) }
  catch { throw fail('ocr_completion_unknown',502) }
  assertCurrent()
  // Recognition can fail after HTTP 200 and whitespace keep-alives. A 200 is
  // neither successful OCR nor evidence that repeating a disconnected job is free.
  check(!result?.error,'ocr_recognition_failed',422)
  check(result?.object === 'ocr.result' && typeof result.id === 'string' && result.id.length <= 256 &&
    result.purpose === asset.parseOptions.purpose && Array.isArray(result.pages) &&
    Number.isSafeInteger(result.page_count) && result.page_count > 0 && result.page_count === result.pages.length &&
    result.pages.length <= maxPages,'invalid_parser_response',502)
  const pages = []
  let remaining = maxTextBytes, partial = false
  for (let index = 0; index < result.pages.length; index++) {
    const page = result.pages[index]
    check(page?.index === index && typeof page.text === 'string' && ['stop','length'].includes(page.finish_reason),'invalid_parser_response',502)
    const normalized = normalizeOCR(page.text)
    const clipped = textPrefix(normalized,remaining)
    remaining -= clipped.bytes
    const truncated = clipped.truncated || page.finish_reason === 'length'
    partial ||= truncated
    pages.push({page:index+1,text:clipped.text,truncated,finishReason:page.finish_reason})
  }
  check(pages.some(page => page.text.trim()),'attachment_no_text',422)
  return {format:'text',coverage:partial ? 'partial' : 'complete',pages,
    warnings:partial ? ['ocr_text_incomplete'] : [],usage:usage(result.usage),
    providerResultId:result.id,providerPageCount:result.page_count,
    // Complete is transport/page coverage according to the OCR service. It
    // cannot assert the accuracy of recognized characters, numbers or tables.
    coverageMeaning:'provider_reported_page_completion'}
}

export async function parseDocument(asset,bytes,env,options) {
  const settings = {...options,fetcher:options.fetcher || fetch,assertCurrent:options.assertCurrent || (() => {})}
  settings.signal?.throwIfAborted()
  let result
  if (asset.parseOptions.parser === 'local') result = local(asset,bytes,settings.maxTextBytes)
  else if (asset.parseOptions.parser === 'cloudflare') result = await cloudflare(asset,bytes,env,settings)
  else if (asset.parseOptions.parser === 'deepseek') result = await deepseek(asset,bytes,env,settings)
  else throw fail('unsupported_parser')
  return {schemaVersion:1,parser:asset.parseOptions.parser,parserVersion:PARSER_VERSION,
    sourceSha256:asset.sha256,...result}
}

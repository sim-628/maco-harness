// Block assembly adapts packages/llm/llm/src/assembler.ts from DeepSeek Harness (MIT).
export class ModelError extends Error {
  constructor(code, {retryable = false, status} = {}) {
    super(code)
    this.name = 'ModelError'
    this.code = code
    this.retryable = retryable
    this.status = status
  }
}

export function malformed() {
  throw new ModelError('malformed_model_stream')
}

export function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed()
  return value
}

export function string(value) {
  if (typeof value !== 'string') malformed()
  return value
}

export function indexOf(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) malformed()
  return value
}

export function tokenCount(value) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) malformed()
  return value
}

// The same text/arguments can appear in the neutral turn and native replay.
// 96 KiB of UTF-8, twice escaped at most sixfold, fits below the 2 MiB SQLite row limit.
export class ContentBudget {
  bytes = 0
  encoder = new TextEncoder()
  take(value) {
    const text = string(value)
    if (text.length > 98304) throw new ModelError('model_content_too_large')
    this.bytes += this.encoder.encode(text).length
    if (this.bytes > 98304) throw new ModelError('model_content_too_large')
    return text
  }
}

// Tool inputs are small mail records. Reject pathological JSON structures before
// schema recursion or native replay serialization can traverse them.
export function toolInput(value) {
  object(value)
  let count = 0
  function visit(node, depth) {
    if (++count > 4096 || depth > 16) malformed()
    if (node === null || typeof node !== 'object') return
    for (const key of Object.keys(node)) visit(node[key], depth + 1)
  }
  visit(value, 0)
  return value
}

export function json(text) {
  try { return JSON.parse(text) }
  catch { malformed() }
}

// Validate the complete batch before exposing its first executable call.
export function completeCalls(blocks, tools, reason) {
  if (reason === 'length' || reason === 'max_tokens') throw new ModelError('model_output_limit')
  if (reason === 'refusal' || reason === 'content_filter') throw new ModelError('model_refusal')
  const toolStop = ['tool_use', 'tool_calls'].includes(reason)
  if (!toolStop && !['end_turn', 'stop_sequence', 'stop'].includes(reason)) malformed()
  if (toolStop !== (blocks.length > 0)) malformed()
  const ids = new Set()
  const allowed = new Set(tools.map(tool => tool.name))
  return blocks.map(block => {
    const {id, name} = block
    if (!id || id.length > 256 || ids.has(id) || !allowed.has(name)) malformed()
    ids.add(id)
    return {type:'tool_call', id, name, arguments:toolInput(json(block.json))}
  })
}

// Only dispatch fully delimited SSE frames. HTTP EOF is never a successful model stop.
export async function* frames(body) {
  if (!body) throw new ModelError('model_stream_interrupted', {retryable:true})
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', {fatal:true})
  const encoder = new TextEncoder()
  let buffer = '', data = [], event, frameSize = 0, bytesRead = 0, frameCount = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > 8 * 1024 * 1024) throw new ModelError('model_stream_too_large')
      buffer += decoder.decode(value, {stream:true})
      let start = 0
      for (let pos = buffer.indexOf('\n'); pos >= 0; pos = buffer.indexOf('\n', start)) {
        const line = buffer.slice(start, pos).replace(/\r$/, '')
        start = pos + 1
        frameSize += encoder.encode(line).byteLength + 1
        if (frameSize > 1024 * 1024) throw new ModelError('model_stream_too_large')
        if (!line) {
          if (++frameCount > 32768) throw new ModelError('model_stream_too_large')
          if (data.length) yield {event, data:data.join('\n')}
          data = []
          event = undefined
          frameSize = 0
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        }
      }
      buffer = buffer.slice(start)
      if (buffer.length > 1024 * 1024) throw new ModelError('model_stream_too_large')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function httpError(status) {
  if (status === 401 || status === 403) return new ModelError('model_authorization_required', {status})
  if (status === 429) return new ModelError('model_rate_limited', {status, retryable:true})
  return new ModelError('model_provider_error', {status, retryable:status >= 500 || status === 408})
}

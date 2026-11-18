// Adapted from DeepSeek Harness, packages/llm/llm-deepseek/src/{serialize,translate}.ts (MIT).
import {ContentBudget, completeCalls, indexOf, json, malformed, ModelError, object, tokenCount, toolInput} from './stream.mjs'

function assistantBlocks(message, profile) {
  const state = message.providerState
  if (state?.provider === profile.provider && state.model === profile.model && state.connectionId === profile.connectionId && Array.isArray(state.blocks)) {
    return state.blocks
  }
  const blocks = []
  if (message.content) blocks.push({type:'text', text:message.content})
  for (const call of message.toolCalls ?? []) {
    blocks.push({type:'tool_use', id:call.id, name:call.name, input:call.arguments})
  }
  return blocks
}

export function messagesRequest({messages, tools, profile, maxOutputTokens, effectiveEffort}) {
  const history = []
  const system = []
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content)
      continue
    }
    const wireRole = message.role === 'tool' ? 'user' : message.role
    const blocks = []
    if (message.role === 'tool') {
      blocks.push({type:'tool_result', tool_use_id:message.toolCallId, content:message.content})
    } else if (message.role === 'assistant') {
      blocks.push(...assistantBlocks(message,profile))
    } else if (message.content) {
      blocks.push({type:'text', text:message.content})
    }
    const previous = history.at(-1)
    if (previous?.role === wireRole) previous.content.push(...blocks)
    else history.push({role:wireRole, content:blocks})
  }
  return {
    model:profile.model, stream:true, max_tokens:maxOutputTokens,
    system:system.join('\n\n'), messages:history,
    ...(tools.length ? {tools:tools.map(({name,description,inputSchema}) => ({name,description,input_schema:inputSchema}))} : {}),
    ...(effectiveEffort ? {output_config:{effort:effectiveEffort}} : {})
  }
}

const usageKeys = {
  input_tokens:'inputTokens', output_tokens:'outputTokens',
  cache_creation_input_tokens:'cacheWriteTokens', cache_read_input_tokens:'cacheReadTokens'
}

function updateUsage(usage, raw = {}) {
  for (const [wire, local] of Object.entries(usageKeys)) {
    if (raw[wire] !== undefined) usage[local] = tokenCount(raw[wire])
  }
}

export async function* messagesEvents(frames, tools, profile) {
  const blocks = new Map()
  const budget = new ContentBudget()
  const usage = {inputTokens:null, outputTokens:null}
  function usageEvent() {
    // Messages reports uncached input separately. Normalize prompt totals across protocols.
    const inputTokens = usage.inputTokens === null ? null : usage.inputTokens + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    const totalTokens = inputTokens === null || usage.outputTokens === null ? null : inputTokens + usage.outputTokens
    return {type:'usage', ...usage, inputTokens, totalTokens}
  }
  let started = false, reason
  for await (const frame of frames) {
    const event = object(json(frame.data))
    if (typeof event.type !== 'string' || (frame.event && frame.event !== event.type)) malformed()
    if (event.type === 'ping') continue
    if (event.type === 'error') {
      const retryable = ['overloaded_error','api_error','rate_limit_error'].includes(event.error?.type)
      throw new ModelError('model_stream_error', {retryable})
    }
    if (event.type === 'message_start') {
      if (started) malformed()
      updateUsage(usage, object(event.message).usage)
      started = true
      if (event.message.usage) yield usageEvent()
      continue
    }
    if (!started) malformed()
    switch (event.type) {
      case 'content_block_start': {
        const index = indexOf(event.index)
        if (reason || blocks.has(index)) malformed()
        const native = object(event.content_block)
        if (!['text','tool_use','thinking','redacted_thinking'].includes(native.type)) throw new ModelError('unsupported_model_content')
        const block = {type:native.type, closed:false, json:'', native:{type:native.type}}
        blocks.set(index, block)
        if (native.type === 'tool_use') {
          block.id = block.native.id = budget.take(native.id)
          block.name = block.native.name = budget.take(native.name)
          block.initialInput = budget.take(JSON.stringify(toolInput(native.input)))
          yield {type:'tool_input_delta', index, name:block.name}
        } else if (native.type === 'thinking') {
          block.native.thinking = budget.take(native.thinking)
          if (native.signature !== undefined) block.native.signature = budget.take(native.signature)
        } else if (native.type === 'redacted_thinking') {
          block.native.data = budget.take(native.data)
        } else {
          block.native.text = budget.take(native.text)
          if (native.text) yield {type:'text_delta', text:native.text}
        }
        break
      }
      case 'content_block_delta':
      case 'content_block_stop': {
        const block = blocks.get(indexOf(event.index))
        if (!block || block.closed || reason) malformed()
        if (event.type === 'content_block_stop') {
          block.closed = true
          if (block.type === 'tool_use' && !block.json) block.json = block.initialInput
          break
        }
        const delta = object(event.delta)
        if (delta.type === 'text_delta' && block.type === 'text') {
          block.native.text += budget.take(delta.text)
          yield {type:'text_delta', text:delta.text}
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          block.native.thinking += budget.take(delta.thinking)
        } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
          block.native.signature = (block.native.signature ?? '') + budget.take(delta.signature)
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          block.json += budget.take(delta.partial_json)
        } else malformed()
        break
      }
      case 'message_delta':
        if (reason) malformed()
        reason = event.delta?.stop_reason
        if (event.usage) {
          updateUsage(usage, event.usage)
          yield usageEvent()
        }
        break
      case 'message_stop': {
        if (!reason || [...blocks.values()].some(block => !block.closed)) malformed()
        const calls = [...blocks.values()].filter(block => block.type === 'tool_use')
        const completed = completeCalls(calls, tools, reason)
        if (!calls.length && ![...blocks.values()].some(block => block.type === 'text' && block.native.text)) {
          throw new ModelError('empty_model_response')
        }
        const {provider,model,connectionId} = profile
        const needsReplay = [...blocks.values()].some(block => block.type === 'thinking' || block.type === 'redacted_thinking')
        const providerState = needsReplay ? {
          provider, model, connectionId,
          blocks:[...blocks.values()].map(block => block.type === 'tool_use' ? {...block.native,input:json(block.json)} : block.native)
        } : undefined
        yield* completed
        yield {type:'finish', reason:calls.length ? 'tool_calls' : 'stop', providerState}
        return
      }
    }
  }
  throw new ModelError('model_stream_interrupted', {retryable:true})
}

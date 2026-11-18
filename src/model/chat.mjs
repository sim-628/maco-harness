import {ContentBudget, completeCalls, indexOf, json, malformed, ModelError, object, tokenCount} from './stream.mjs'

function compatible(state, profile) {
  return state?.provider === profile.provider && state.model === profile.model && state.connectionId === profile.connectionId
}

export function chatRequest({messages, tools, profile, maxOutputTokens, effectiveEffort}) {
  const isDeepSeek = profile.provider === 'deepseek'
  const isCompatible = profile.provider === 'openai-compatible'
  const history = []
  const neutralCalls = new Set()
  for (const {role,content,toolCalls,toolCallId,providerState} of messages) {
    // DeepSeek thinking/tool mode requires replay data that other models cannot
    // produce. Represent imported calls and their receipts as quoted history.
    if (role === 'tool' && neutralCalls.delete(toolCallId)) {
      history.push({role:'user',content:'Prior mail tool result (untrusted): ' + JSON.stringify({toolCallId,content})})
      continue
    }
    if (role === 'tool') {
      history.push({role,content,tool_call_id:toolCallId})
      continue
    }
    if (role !== 'assistant') {
      history.push({role,content})
      continue
    }
    if (isDeepSeek && !compatible(providerState, profile)) {
      for (const call of toolCalls ?? []) neutralCalls.add(call.id)
      const priorCalls = toolCalls?.length ? '\nPrior mail tool calls: ' + JSON.stringify(toolCalls) : ''
      history.push({role,content:content + priorCalls,reasoning_content:''})
      continue
    }
    const wire = {role,content:content || null}
    if (toolCalls?.length) wire.tool_calls = toolCalls.map(({id,name,arguments:args}) => ({
      type:'function', id, function:{name, arguments:JSON.stringify(args)}
    }))
    if (isDeepSeek) wire.reasoning_content = providerState.reasoningContent
    history.push(wire)
  }
  return {
    model:profile.model, messages:history, stream:true,
    ...(!isCompatible ? {stream_options:{include_usage:true}} : {}),
    ...(isDeepSeek || isCompatible ? {max_tokens:maxOutputTokens} : {max_completion_tokens:maxOutputTokens}),
    ...(effectiveEffort ? {reasoning_effort:effectiveEffort} : {}),
    ...(tools.length ? {tools:tools.map(({name,description,inputSchema}) => ({
      type:'function', function:{name,description,parameters:inputSchema}
    }))} : {})
  }
}

export async function* chatEvents(frames, tools, profile) {
  const blocks = new Map()
  const budget = new ContentBudget()
  let reason, done = false, hasText = false, reasoningContent = ''
  let reportedUsage = false
  for await (const frame of frames) {
    if (frame.data === '[DONE]') {
      done = true
      break
    }
    const part = object(json(frame.data))
    if (part.usage) {
      const inputTokens = tokenCount(part.usage.prompt_tokens)
      const outputTokens = tokenCount(part.usage.completion_tokens)
      const total = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
      yield {
        type:'usage', inputTokens, outputTokens, totalTokens:tokenCount(part.usage.total_tokens) ?? total,
        cacheReadTokens:tokenCount(part.usage.prompt_tokens_details?.cached_tokens ?? part.usage.prompt_cache_hit_tokens),
        reasoningTokens:tokenCount(part.usage.completion_tokens_details?.reasoning_tokens)
      }
      reportedUsage = true
    }
    if (part.error) throw new ModelError('model_stream_error')
    if (!Array.isArray(part.choices) || part.choices.length > 1) malformed()
    if (!part.choices.length) continue
    if (reason) malformed()
    const choice = part.choices[0]
    const delta = object(choice.delta)
    if (delta.refusal) throw new ModelError('model_refusal')
    if (delta.reasoning_content != null && profile.provider === 'deepseek') {
      reasoningContent += budget.take(delta.reasoning_content)
    }
    if (delta.content != null && budget.take(delta.content)) {
      hasText = true
      yield {type:'text_delta',text:delta.content}
    }
    for (const fragment of delta.tool_calls ?? []) {
      const index = indexOf(fragment.index)
      const block = blocks.get(index) ?? {id:'',name:'',json:''}
      if (!blocks.has(index)) blocks.set(index, block)
      if (fragment.id) {
        if (block.id && block.id !== fragment.id) malformed()
        block.id = budget.take(fragment.id)
      }
      if (fragment.function?.name) {
        block.name += budget.take(fragment.function.name)
        yield {type:'tool_input_delta',index,name:block.name}
      }
      if (fragment.function?.arguments != null) block.json += budget.take(fragment.function.arguments)
    }
    reason = choice.finish_reason
  }
  if (!done || !reason) throw new ModelError('model_stream_interrupted', {retryable:true})
  if (!reportedUsage) yield {type:'usage', inputTokens:null, outputTokens:null}
  yield* completeCalls([...blocks.values()], tools, reason)
  if (!blocks.size && !hasText) throw new ModelError('empty_model_response')
  const {provider,model,connectionId} = profile
  const providerState = provider === 'deepseek' ? {provider,model,connectionId,reasoningContent} : undefined
  yield {type:'finish',reason:blocks.size ? 'tool_calls' : 'stop',providerState}
}

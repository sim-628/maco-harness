import {chatEvents, chatRequest} from './chat.mjs'
import {messagesEvents, messagesRequest} from './messages.mjs'
import {frames, httpError, ModelError} from './stream.mjs'
import {compatibleProvider, normalizeModelBaseUrl} from './endpoint.mjs'
export {buildContext} from './context.mjs'
export {ModelError} from './stream.mjs'

// Endpoints belong to trusted adapters. An inbound model profile cannot select an HTTP destination.
const providers = new Map([
  ['openai', {
    url:'https://api.openai.com/v1/chat/completions', protocol:'chat_completions',
    effort:/^(?:o3(?:-mini)?|o4-mini|gpt-5(?:\.\d+)?(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/,
    request:chatRequest, events:chatEvents, headers:key => ({Authorization:'Bearer ' + key})
  }],
  ['deepseek', {
    url:'https://api.deepseek.com/chat/completions', protocol:'chat_completions',
    effort:/^deepseek-(?:flash|v4-(?:flash|pro))$/,
    request:chatRequest, events:chatEvents, headers:key => ({Authorization:'Bearer ' + key})
  }],
  ['anthropic', {
    url:'https://api.anthropic.com/v1/messages', protocol:'messages',
    effort:/^claude-(?:opus-4-[5-8]|sonnet-4-6|(?:opus|sonnet)-5(?:-5)?|haiku-5-5|(?:mythos|fable)-5(?:-[12])?)(?:-\d{8})?$/,
    request:messagesRequest, events:messagesEvents, headers:key => ({'x-api-key':key,'anthropic-version':'2023-06-01'})
  }],
  [compatibleProvider, {
    protocol:'chat_completions',
    // Endpoints and keys come together from the epoch-checked connection. The
    // profile contains only provider/model/effort/connectionId, never a URL.
    request:chatRequest, events:chatEvents, headers:key => ({Authorization:'Bearer ' + key})
  }]
])

export function modelCapabilities({provider,model}) {
  const adapter = providers.get(provider)
  if (!adapter || typeof model !== 'string' || !model.trim() || model.length > 200) throw new ModelError('invalid_model_profile')
  const efforts = ['provider-default']
  if (adapter.effort?.test(model)) efforts.push('low', ...(provider === 'deepseek' ? [] : ['medium']), 'high')
  return {provider,model,protocol:adapter.protocol,tools:true,stream:true,efforts}
}

export async function* streamStep({profile, credential, messages, tools = [], signal, maxOutputTokens = 4096, fetchImpl = fetch}) {
  const capabilities = modelCapabilities(profile)
  const adapter = providers.get(profile.provider)
  if (!credential || typeof credential.apiKey !== 'string' || !credential.apiKey.trim()) throw new ModelError('model_authorization_required')
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > 32768) throw new ModelError('invalid_output_budget')
  const requestedEffort = profile.effort ?? 'provider-default'
  if (!['provider-default','low','medium','high'].includes(requestedEffort)) throw new ModelError('invalid_model_effort')
  let effectiveEffort = requestedEffort === 'provider-default' ? null : requestedEffort
  if (!capabilities.efforts.includes(requestedEffort)) {
    effectiveEffort = profile.provider === 'deepseek' && capabilities.efforts.includes('high') && requestedEffort === 'medium' ? 'high' : null
    yield {type:'warning',code:profile.provider === compatibleProvider ? 'model_effort_unsupported' : 'model_effort_mapped',requestedEffort,effectiveEffort}
  }
  const endpoint = profile.provider === compatibleProvider
    ? normalizeModelBaseUrl(credential.baseUrl) + '/chat/completions' : adapter.url
  const request = adapter.request({messages,tools,profile,maxOutputTokens,effectiveEffort})
  try {
    signal?.throwIfAborted()
    const response = await fetchImpl(endpoint, {
      method:'POST', headers:{...adapter.headers(credential.apiKey),'Content-Type':'application/json', Accept:'text/event-stream'},
      body:JSON.stringify(request), signal, redirect:'manual'
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw httpError(response.status)
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel().catch(() => {})
      throw new ModelError('malformed_model_stream')
    }
    for await (const event of adapter.events(frames(response.body), tools, profile)) {
      signal?.throwIfAborted()
      yield event.type === 'finish' ? {...event,requestedEffort,effectiveEffort} : event
    }
  } catch (error) {
    if (signal?.aborted) throw new ModelError('model_cancelled')
    if (error instanceof ModelError) throw error
    // Remote and transport error strings may echo user content or request headers.
    throw new ModelError('model_transport_error', {retryable:true})
  }
}

import {ModelError} from './stream.mjs'

export const compatibleProvider = 'openai-compatible'

function invalid() {
  throw new ModelError('invalid_model_base_url', {status:400})
}

function publicHostname(host) {
  // Only DNS hostnames, never IP literals (including URL-normalized decimal,
  // octal or hex IPv4 forms). A hostname allowlist below is still required:
  // string validation alone cannot prevent DNS rebinding by a hostname owner.
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|lan|home|corp)$/.test(host)
    && !host.endsWith('.home.arpa')
}

export function normalizeModelBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()
    || /[\x00-\x20\x7f\\?#]/.test(value)) invalid()
  let url
  try { url = new URL(value) } catch { invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || value.split('/')[2]?.includes('@') || !publicHostname(url.hostname)) invalid()
  // Model endpoints only need ordinary path segments. Excluding escaped path
  // separators and dot navigation keeps one configured prefix unambiguous.
  if (!/^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]*$/.test(url.pathname)
    || value.split('/').some(part => part === '.' || part === '..')
    || url.pathname.endsWith('/chat/completions')) invalid()
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function configuredModelBaseUrl(value, configuredHosts) {
  const baseUrl = normalizeModelBaseUrl(value)
  const hosts = typeof configuredHosts === 'string'
    ? configuredHosts.split(/[\s,]+/).filter(Boolean).map(host => host.toLowerCase()) : []
  // Exact deployment-controlled hosts, never wildcards or model-supplied URLs.
  // Operators must only list provider domains they trust; this does not pin DNS
  // resolution or certify arbitrary user-controlled CNAME targets as public.
  if (!hosts.length || hosts.some(host => !publicHostname(host))
    || !hosts.includes(new URL(baseUrl).hostname)) {
    throw new ModelError('model_endpoint_not_allowed', {status:403})
  }
  return baseUrl
}

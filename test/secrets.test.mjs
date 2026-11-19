import test from 'node:test'
import assert from 'node:assert/strict'
import { hasSecret, readSecret } from '../src/secrets.mjs'
import { VaultCipher } from '../src/connections/crypto.mjs'

test('secret sources support strings and bound get receivers, without caching rotated API keys', async () => {
  assert.equal(await readSecret(' ordinary-secret '), ' ordinary-secret ')
  const binding = { value: 'first-key', async get() { return this.value } }
  assert.equal(hasSecret(binding), true)
  assert.equal(await readSecret(binding), 'first-key')
  binding.value = 'second-key'
  assert.equal(await readSecret(binding), 'second-key')
  for (const value of [undefined, null, {}, 123, '', '  ']) assert.equal(hasSecret(value), false)
})

test('lookup errors and malformed values are bounded and expose only a fixed error code', async () => {
  const sensitive = 'secret-from-upstream-error'
  for (const source of [undefined, ' ', { get: async () => ({ value: sensitive }) },
    { get: async () => '' }, { get: async () => 'ééé' },
    { get() { throw new Error(sensitive) } }, { get: async () => { throw new Error(sensitive) } }]) {
    await assert.rejects(readSecret(source, { code: 'fixture_secret_unavailable', maxBytes: 4 }), error => {
      assert.equal(error.code, 'fixture_secret_unavailable')
      assert.equal(error.status, 503)
      assert.equal(error.beforeDispatch, true)
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), new RegExp(sensitive))
      return true
    })
  }
})

test('secret lookup timeout and cancellation discard late results and allow a fresh retry', async () => {
  let release, reads = 0
  const pending = new Promise(resolve => { release = resolve })
  const source = { get() { reads++; return reads === 1 ? pending : 'current-key' } }
  await assert.rejects(readSecret(source, { timeoutMs: 10 }), { code: 'secret_unavailable', beforeDispatch: true })
  release('obsolete-key')
  assert.equal(await readSecret(source), 'current-key')
  const cancelled = new AbortController()
  cancelled.abort(new Error('private-reason'))
  await assert.rejects(readSecret(source, { signal: cancelled.signal }), { code: 'secret_unavailable' })
  assert.equal(reads, 2)
  const controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const request = readSecret({ get() { started(); return new Promise(() => {}) } }, { signal: controller.signal })
  const failure = assert.rejects(request, { code: 'secret_unavailable', beforeDispatch: true })
  await ready
  controller.abort()
  await failure
})

test('a fixed-version vault binding retries an initial outage and survives reconstruction with the same key', async () => {
  let reads = 0
  const source = { async get() {
    reads++
    if (reads === 1) throw Error('temporary secret-store failure')
    return Buffer.alloc(32, 47).toString('base64')
  } }
  const vault = new VaultCipher(source, 'owner-binding')
  await assert.rejects(vault.seal(['model'], { key: 'test-model-key' }), { code: 'vault_key_invalid' })
  const sealed = await vault.seal(['model'], { key: 'test-model-key' })
  assert.deepEqual(await vault.open(['model'], sealed), { key: 'test-model-key' })
  assert.equal(reads, 2)
  const reopened = new VaultCipher(source, 'owner-binding')
  assert.deepEqual(await reopened.open(['model'], sealed), { key: 'test-model-key' })
  assert.equal(reads, 3)
  await assert.rejects(new VaultCipher(source, 'other-owner').open(['model'], sealed), { code: 'vault_decryption_failed' })
})

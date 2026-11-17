import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'

test('defaults follow the UI selection and block foreign calls', () => {
  const config = resolveConfig({ auditLog: false })
  assert.equal(config.followSelection, true)
  assert.equal(config.onForeignProvider, 'block')
  assert.equal(config.blockAutoSwitch, true)
  assert.equal(config.blockForeignProviderHosts, true)
  assert.equal(config.mode, 'enforce')
})

test('a pinned mode needs a provider', () => {
  assert.throws(() => resolveConfig({ followSelection: false, auditLog: false }), /fallbackProvider/)
  const config = resolveConfig({ followSelection: false, fallbackProvider: 'deepseek-official', auditLog: false })
  assert.equal(config.fallbackProvider, 'deepseek-official')
})

test('providerHosts accepts patterns and rejects junk', () => {
  const config = resolveConfig({
    auditLog: false,
    providerHosts: { 'my-gateway': ['api.example.com', '*.example.net'] },
  })
  assert.deepEqual(config.providerHosts['my-gateway'], ['api.example.com', '*.example.net'])
  assert.throws(() => resolveConfig({ providerHosts: { p: 'x' } }), /array/)
  assert.throws(() => resolveConfig({ providerHosts: { p: ['*'] } }), /bare/)
})
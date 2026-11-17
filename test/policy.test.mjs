import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { BYPASS, createPolicy } from '../lib/policy.js'

function fakeCtx(selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'agentDefaultModel') return { currentSelection: () => selection }
        if (name === 'llm') {
          return {
            stream(options) {
              calls.push(options)
              return (async function* generate() {
                yield { type: 'text', text: 'ok' }
              })()
            },
          }
        }
        return undefined
      },
    },
  }
}

async function drain(iterable) {
  for await (const _chunk of iterable) { /* drain */ }
}

test('a hidden call to another provider is blocked by default', () => {
  const { ctx, calls } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  assert.throws(
    () => policy.onStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] }, () => 'next'),
    error => error.code === 'PROVIDER_MISMATCH' && error.fromProvider === 'deepseek-official',
  )
  assert.equal(calls.length, 0)
  assert.equal(policy.snapshot().stats.blocked, 1)
})

test('reroute is opt-in and lands on the selected provider/model', async () => {
  const { ctx, calls } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false, onForeignProvider: 'reroute' }), ctx)
  const result = policy.onStream(
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] },
    () => 'next-was-called',
  )
  await drain(result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'opencode-go')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(Object.getOwnPropertySymbols(calls[0]).includes(BYPASS), true)
  assert.equal(policy.snapshot().stats.rerouted, 1)
})

test('the reroute bypass marker short-circuits recursion', () => {
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  let called = 0
  const result = policy.onStream({ [BYPASS]: true, provider: 'deepseek-official' }, () => {
    called += 1
    return 'downstream'
  })
  assert.equal(result, 'downstream')
  assert.equal(called, 1)
})

test('a frozen main-loop call that differs from the UI selection is blocked as an auto-switch', () => {
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
  assert.throws(
    () => policy.onStream(request, () => 'downstream'),
    error => error.code === 'PROVIDER_AUTO_SWITCH_BLOCKED' && error.fromProvider === 'deepseek-official',
  )
  assert.equal(policy.snapshot().stats.autoSwitchBlocked, 1)
  assert.equal(policy.snapshot().selected.provider, 'opencode-go')
})

test('a frozen main-loop call that matches the UI selection is trusted', async () => {
  const { ctx } = fakeCtx({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
  let called = 0
  const stream = policy.onStream(request, () => {
    called += 1
    return (async function* downstream() { yield 'downstream' })()
  })
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.deepEqual(chunks, ['downstream'])
  assert.equal(called, 1)
  assert.equal(policy.snapshot().selected.provider, 'deepseek-official')
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, true)
  assert.equal(policy.hostDecision('opencode.ai', 443).allowed, false)
})

test('a terminal provider failure carries the no-auto-switch note', async () => {
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  const request = Object.freeze({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', messages: [] })
  const stream = policy.onStream(request, () => (async function* failed() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA_EXCEEDED' } } }
  })())
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'QUOTA_EXCEEDED')
  assert.match(chunks[0].reason.failure.message, /不会自动切换/)
  assert.match(chunks[0].reason.failure.message, /手动/)
})

test('block mode refuses a hidden foreign call without touching the adapter', () => {
  const { ctx, calls } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false, onForeignProvider: 'block' }), ctx)
  assert.throws(
    () => policy.onStream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] }, () => 'next'),
    error => error.code === 'PROVIDER_MISMATCH' && error.fromProvider === 'deepseek-official',
  )
  assert.equal(calls.length, 0)
})

test('host policy blocks only another provider endpoint, not ordinary traffic', () => {
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, false)
  assert.equal(policy.hostDecision('api.deepseek.com', 443).foreignProvider, 'deepseek-official')
  assert.equal(policy.hostDecision('registry.npmjs.org', 443).allowed, true)
  assert.equal(policy.hostDecision('ilinkai.weixin.qq.com', 443).allowed, true)
  assert.equal(policy.hostDecision('127.0.0.1', 8080).allowed, true)
  assert.equal(policy.hostDecision('example.com', 443).allowed, true)
})

test('a live UI switch swaps the provider without reinstalling', async () => {
  const selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...selection }) }
      return undefined
    },
  }
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  assert.equal(policy.hostDecision('opencode.ai', 443).allowed, true)
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, false)
  selection.provider = 'deepseek-official'
  selection.model = 'deepseek-v4-flash'
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, true)
  assert.equal(policy.hostDecision('opencode.ai', 443).allowed, false)
  const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
  const stream = policy.onStream(request, () => (async function* downstream() { yield 'downstream' })())
  for await (const _chunk of stream) { /* drain */ }
})

test('selecting DeepSeek swaps the allowed provider endpoint', () => {
  const { ctx } = fakeCtx({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, true)
  assert.equal(policy.hostDecision('opencode.ai', 443).allowed, false)
})

test('custom provider hosts replace the built-in table for that provider', () => {
  const { ctx } = fakeCtx({ provider: 'acme', model: 'acme-large' })
  const policy = createPolicy(resolveConfig({
    auditLog: false,
    providerHosts: { acme: ['gateway.acme.example'] },
  }), ctx)
  assert.equal(policy.hostDecision('gateway.acme.example', 443).allowed, true)
  assert.equal(policy.hostDecision('api.deepseek.com', 443).allowed, false)
})

test('install blocks a foreign provider fetch before the socket and allows loopback', async () => {
  const server = http.createServer((_req, res) => res.end('ok'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog: false }), ctx)
  policy.install()
  try {
    await assert.rejects(
      fetch('https://api.deepseek.com/v1/tools/search'),
      error => error.code === 'PROVIDER_HOST_BLOCKED' && error.host === 'api.deepseek.com',
    )
    const response = await fetch('http://127.0.0.1:' + port + '/')
    assert.equal(await response.text(), 'ok')
  } finally {
    policy.dispose()
    await new Promise(resolve => server.close(resolve))
  }
})

test('audit mode records a would-be block but lets the request through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-guard-audit-'))
  const auditLog = join(dir, 'audit.jsonl')
  const { ctx } = fakeCtx()
  const policy = createPolicy(resolveConfig({ auditLog, mode: 'audit' }), ctx)
  policy.checkHost('api.deepseek.com', 443, { url: 'https://api.deepseek.com/v1/tools/search' })
  const lines = readFileSync(auditLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.at(-1).decision, 'allowed')
  assert.match(lines.at(-1).reason, /audit-only/)
  rmSync(dir, { recursive: true, force: true })
})
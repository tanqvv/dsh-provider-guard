#!/usr/bin/env node
/**
 * Manual smoke test against the real LlmRuntime.
 *
 *   node scripts/smoke-provider.mjs
 *
 * Proves:
 * - a hidden DeepSeek call is blocked by default and never reaches the adapter;
 * - explicit reroute lands on the selected provider/model;
 * - a frozen main-loop request that differs from the selection is stopped as an
 *   auto-switch, not trusted;
 * - a frozen main-loop request that matches the selection is trusted.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const modules = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
const cordisPath = join(modules, 'cordis', 'lib', 'index.js')
const llmPath = join(modules, 'dsh-llm', 'lib', 'index.js')
for (const path of [cordisPath, llmPath]) {
  if (!existsSync(path)) {
    console.error('Missing ' + path + '; install DSH or set DSH_HOME')
    process.exit(1)
  }
}
const { Context } = await import(pathToFileURL(cordisPath).href)
const { LlmRuntime } = await import(pathToFileURL(llmPath).href)
const { apply } = await import('../lib/index.js')

async function newScenario(config) {
  const calls = []
  function adapter(name) {
    const stream = (options) => {
      calls.push({ adapter: name, provider: options.provider, model: options.model })
      return (async function* empty() {})()
    }
    return {
      providerInfo: (provider) => ({ id: provider, name: provider }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
      async prepareCall(provider, model) {
        return { model: await this.resolveModel(provider, model), stream }
      },
      stream,
    }
  }
  const ctx = new Context()
  ctx.plugin(LlmRuntime)
  await new Promise(resolve => setTimeout(resolve, 50))
  ctx.llm.registerAdapter(['deepseek-official'], adapter('deepseek'))
  ctx.llm.registerAdapter(['opencode-go'], adapter('opencode'))
  const fiber = ctx.plugin({ name: 'provider-guard-smoke', apply }, config)
  await new Promise(resolve => setTimeout(resolve, 100))
  return { ctx, calls, dispose: () => fiber.dispose() }
}

async function drain(iterable) {
  for await (const _chunk of iterable) { /* drain */ }
}

let failed = false
function check(ok, label, detail) {
  console.log(ok ? '[ok] ' + label : '[fail] ' + label + (detail === undefined ? '' : ': ' + detail))
  failed ||= !ok
}

// 1. Default: a hidden foreign call is blocked, adapter untouched.
{
  const s = await newScenario({
    followSelection: false,
    fallbackProvider: 'opencode-go',
    fallbackModel: 'deepseek-v4.1-flash',
    auditLog: false,
  })
  try {
    let code
    try {
      await drain(s.ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [], purpose: 'compaction' }))
    } catch (error) {
      code = error.code
    }
    check(code === 'PROVIDER_MISMATCH', 'hidden DeepSeek call blocked by default', code)
    check(s.calls.length === 0, 'blocked call never reached an adapter', JSON.stringify(s.calls))
  } finally {
    await s.dispose()
  }
}

// 2. Explicit opt-in reroute.
{
  const s = await newScenario({
    followSelection: false,
    fallbackProvider: 'opencode-go',
    fallbackModel: 'deepseek-v4.1-flash',
    onForeignProvider: 'reroute',
    auditLog: false,
  })
  try {
    await drain(s.ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [], purpose: 'compaction' }))
    check(s.calls.length === 1 && s.calls[0].adapter === 'opencode' && s.calls[0].model === 'deepseek-v4.1-flash',
      'explicit reroute lands on opencode', JSON.stringify(s.calls))
  } finally {
    await s.dispose()
  }
}

// 3. Frozen main-loop request that differs from the selection is an auto-switch.
{
  const s = await newScenario({
    followSelection: false,
    fallbackProvider: 'opencode-go',
    fallbackModel: 'deepseek-v4.1-flash',
    auditLog: false,
  })
  try {
    const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
    let code
    try {
      await drain(s.ctx.llm.stream(request))
    } catch (error) {
      code = error.code
    }
    check(code === 'PROVIDER_AUTO_SWITCH_BLOCKED', 'main-loop auto-switch blocked', code)
    check(s.calls.length === 0, 'auto-switch never reached an adapter', JSON.stringify(s.calls))
  } finally {
    await s.dispose()
  }
}

// 4. Frozen main-loop request that matches the selection is trusted.
{
  const s = await newScenario({
    followSelection: false,
    fallbackProvider: 'deepseek-official',
    fallbackModel: 'deepseek-v4-flash',
    auditLog: false,
  })
  try {
    const request = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
    await drain(s.ctx.llm.stream(request))
    check(s.calls.length === 1 && s.calls[0].adapter === 'deepseek',
      'matching main-loop call trusted', JSON.stringify(s.calls))
  } finally {
    await s.dispose()
  }
}

process.exit(failed ? 1 : 0)

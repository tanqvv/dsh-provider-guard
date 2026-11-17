/**
 * dsh-provider-guard - keep every model call on the provider currently
 * selected in the DSH UI.
 *
 * The main agent loop already follows the selection. This plugin closes the
 * auxiliary paths that do not: title/compaction/other plugins naming a
 * different provider route, and provider-specific HTTP services such as
 * DeepSeek web search that bypass `llm/stream`. Foreign LLM calls are
 * rerouted to the selected provider/model; another provider's endpoint is
 * blocked only when it is a model-provider endpoint. Ordinary network traffic
 * is not touched.
 *
 * @module dsh-provider-guard
 */

import { resolveConfig } from './config.js'
import { createPolicy } from './policy.js'
import { registerStatusTool } from './tool.js'

export const name = 'provider-guard'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const policy = createPolicy(resolved, ctx)
  policy.install()
  try {
    ctx.effect(() => () => policy.dispose())
    ctx.on('llm/stream', (options, next) => policy.onStream(options, next), { global: true, prepend: true })
    registerStatusTool(ctx, policy)
  } catch (error) {
    policy.dispose()
    throw error
  }

  const status = policy.snapshot()
  console.log(
    '[dsh-provider-guard] 已启用：跟随当前选择'
    + (status.selected === undefined ? '（尚未读到选择）' : '（' + status.selected.provider + '/' + (status.selected.model ?? '?') + '）')
    + '，自动切换供应商 ' + (resolved.blockAutoSwitch ? '拦截' : '允许')
    + '，跨供应商模型调用 ' + resolved.onForeignProvider
    + '，' + (resolved.blockForeignProviderHosts ? '拦截其他供应商端点' : '不拦截供应商端点')
    + '，模式 ' + resolved.mode,
  )
}
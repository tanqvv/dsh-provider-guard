/**
 * Status tool for dsh-provider-guard. It performs no network request.
 *
 * @module dsh-provider-guard/tool
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatStatus(value) {
  const status = /** @type {Record<string, any>} */ (value)
  const selected = status.selected
  const live = status.live
  const lines = []
  lines.push('dsh-provider-guard 状态')
  lines.push('- 运行模式：' + status.mode + (status.mode === 'audit' ? '（只记录，不改道）' : '（生效）'))
  lines.push('- 跟随 UI 选择：' + (status.followSelection ? '是' : '否（使用 fallback）'))
  lines.push('- 自动切换供应商：' + (status.blockAutoSwitch ? '拦截并停止' : '允许'))
  lines.push('- 跨供应商模型调用：' + status.onForeignProvider
    + (status.onForeignProvider === 'reroute' ? '（改走当前选择的模型）' : status.onForeignProvider === 'block' ? '（阻止）' : '（只记录）'))
  lines.push('- 其他供应商端点：' + (status.blockForeignProviderHosts ? '拦截' : '放行'))
  lines.push('- 当前生效：' + (selected === undefined ? '（未读到）' : selected.provider + (selected.model === undefined ? '' : ' / ' + selected.model)))
  if (live !== undefined && (selected === undefined || live.provider !== selected.provider || live.model !== selected.model)) {
    lines.push('- UI 当前选择：' + live.provider + (live.model === undefined ? '' : ' / ' + live.model))
  }
  lines.push('- 当前供应商端点：' + (status.allowedHosts.length > 0 ? status.allowedHosts.join(', ') : '（未配置）'))
  lines.push('- 审计日志：' + (status.auditLog ?? '关闭') + (status.auditErrors > 0 ? '（写入失败 ' + status.auditErrors + ' 次）' : ''))
  lines.push('- 统计：自动切换拦截 ' + status.stats.autoSwitchBlocked + ' 次，改道 ' + status.stats.rerouted
    + ' 次，阻止 ' + status.stats.blocked + ' 次（其中端点拦住 ' + status.stats.hostBlocked
    + ' 次），发现跨供应商模型调用 ' + status.stats.foreignCalls + ' 次')
  const recent = Array.isArray(status.recent) ? status.recent : []
  if (recent.length === 0) {
    lines.push('- 最近改道/拦截：无')
  } else {
    lines.push('- 最近改道/拦截：')
    for (const entry of recent.slice(0, 10)) {
      const what = entry.layer === 'llm'
        ? String(entry.fromProvider ?? '?') + ' → ' + String(entry.toProvider ?? '?') + (entry.model === undefined ? '' : ' / ' + entry.model)
        : String(entry.host ?? '?') + (entry.port === undefined ? '' : ':' + entry.port)
      lines.push('  - ' + entry.time + ' [' + entry.decision + '/' + entry.layer + '] ' + what + (entry.reason === undefined ? '' : ' — ' + entry.reason))
    }
  }
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./policy.js').createPolicy>} policy
 */
export function registerStatusTool(ctx, policy) {
  const names = ['provider_guard_status', 'egress_guard_status']
  for (const name of names) {
    const definition = {
      name,
      description: '查看 dsh-provider-guard：当前跟随的模型供应商、跨供应商调用改道/拦截统计和最近记录。不发起网络请求。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
      },
      async execute() {
        return policy.snapshot()
      },
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (child) => {
        child.effect(() => child.tools.register(definition))
      })
    }
  }
}
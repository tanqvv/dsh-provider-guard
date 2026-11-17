/**
 * Provider-affinity policy.
 *
 * The harness already routes the user's main model loop through the selected
 * provider. The leaks this policy closes are the auxiliary paths:
 *
 * - an `llm/stream` call built by a title, compaction, subagent, memory, or
 *   other plugin that names another provider route;
 * - provider-specific HTTP services such as DeepSeek's `/v1/tools/search`
 *   that do not use `llm/stream` at all.
 *
 * Foreign LLM calls are rerouted to the selected provider and its selected
 * model. Foreign *provider endpoints* are blocked only when they belong to a
 * known model provider other than the selected one; ordinary traffic (npm
 * updates, WeChat, remote control, web fetch) is untouched.
 *
 * @module dsh-provider-guard/policy
 */

import net from 'node:net'
import { createAuditLog } from './audit.js'
import {
  defaultPortForProtocol, hostMatchesAny, isLoopbackHost, isPrivateHost, normalizeHost,
} from './hosts.js'

/**
 * @typedef {import('./config.js').ProviderGuardConfig} ProviderGuardConfig
 * @typedef {{ provider: string, model?: string }} Selection
 * @typedef {{ layer: 'llm' | 'host', host?: string, port?: number, url?: string, fromProvider?: string, toProvider?: string, model?: string, reason?: string }} Target
 */

/** Marker set on the clone passed back into `llm.stream` to avoid a reroute loop. */
export const BYPASS = Symbol.for('dsh-provider-guard.bypass')

/**
 * Endpoints that belong to model providers. This is deliberately a provider
 * map, not an internet allowlist: hosts absent here are ordinary traffic and
 * pass through. A hand-declared gateway adds itself through `providerHosts`.
 */
export const PROVIDER_HOSTS = {
  'deepseek-official': ['api.deepseek.com'],
  'deepseek': ['api.deepseek.com'],
  'opencode-go': ['opencode.ai'],
  'opencode': ['opencode.ai'],
  'openai': ['api.openai.com'],
  'anthropic': ['api.anthropic.com'],
  'openrouter': ['openrouter.ai'],
  'google': ['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'],
  'google-vertex': ['aiplatform.googleapis.com'],
  'zai': ['api.z.ai', 'open.bigmodel.cn'],
  'zai-coding-cn': ['open.bigmodel.cn'],
  'moonshotai': ['api.moonshot.ai'],
  'moonshotai-cn': ['api.moonshot.cn'],
  'kimi-coding': ['api.kimi.com'],
  'minimax': ['api.minimax.io'],
  'minimax-cn': ['api.minimaxi.com'],
  'qwen-token-plan': ['portal.qwen.ai'],
  'qwen-token-plan-cn': ['portal.qwen.ai'],
  'xiaomi': ['api.xiaomimimo.com'],
  'nvidia': ['integrate.api.nvidia.com'],
  'groq': ['api.groq.com'],
  'cerebras': ['api.cerebras.ai'],
  'mistral': ['api.mistral.ai'],
  'github-copilot': ['api.githubcopilot.com'],
  'vercel-ai-gateway': ['ai-gateway.vercel.sh'],
}

/** A request tried to move the session to a different provider without a user selection change. */
export class ProviderAutoSwitchError extends Error {
  /**
   * @param {string} message
   * @param {Target} target
   */
  constructor(message, target) {
    super(message)
    this.name = 'ProviderAutoSwitchError'
    this.code = 'PROVIDER_AUTO_SWITCH_BLOCKED'
    this.fromProvider = target.fromProvider
    this.toProvider = target.toProvider
    this.model = target.model
    this.details = target
  }
}

/** A model call named a provider other than the selected one. */
export class ProviderMismatchError extends Error {
  /**
   * @param {string} message
   * @param {Target} target
   */
  constructor(message, target) {
    super(message)
    this.name = 'ProviderMismatchError'
    this.code = 'PROVIDER_MISMATCH'
    this.fromProvider = target.fromProvider
    this.toProvider = target.toProvider
    this.model = target.model
    this.details = target
  }
}

/** A request targeted a known model-provider endpoint other than the selected provider. */
export class ProviderHostBlockedError extends Error {
  /**
   * @param {string} message
   * @param {Target} target
   */
  constructor(message, target) {
    super(message)
    this.name = 'ProviderHostBlockedError'
    this.code = 'PROVIDER_HOST_BLOCKED'
    this.host = target.host
    this.port = target.port
    this.url = target.url
    this.fromProvider = target.fromProvider
    this.toProvider = target.toProvider
    this.details = target
  }
}

/**
 * Resolve the target described by `socket.connect`'s arguments. `net.connect`
 * passes its normalized argument array as one argument, so recurse into it.
 *
 * @param {unknown[]} args
 * @returns {{ kind: 'tcp', host: string, port: number | undefined } | { kind: 'unix', path: string } | { kind: 'unknown' }}
 */
export function describeConnectTarget(args) {
  if (Array.isArray(args[0])) return describeConnectTarget(args[0])
  const first = args[0]
  if (typeof first === 'object' && first !== null) {
    const options = /** @type {Record<string, unknown>} */ (first)
    if (typeof options.path === 'string' && options.path.length > 0) return { kind: 'unix', path: options.path }
    const portValue = options.port
    const port = typeof portValue === 'number'
      ? portValue
      : typeof portValue === 'string' && /^\d+$/.test(portValue) ? Number(portValue) : undefined
    const hostValue = options.host ?? options.hostname
    const host = typeof hostValue === 'string' && hostValue.length > 0 ? hostValue : 'localhost'
    if (port === undefined && hostValue === undefined) return { kind: 'unknown' }
    return { kind: 'tcp', host, port }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { kind: 'unix', path: first }
  const port = typeof first === 'number' ? first : typeof first === 'string' ? Number(first) : undefined
  const host = typeof args[1] === 'string' && args[1].length > 0 ? args[1] : 'localhost'
  if (port === undefined) return { kind: 'unknown' }
  return { kind: 'tcp', host, port }
}

/**
 * Keep the path but drop credentials, query, and fragment.
 * @param {URL} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
  return url.origin + (url.pathname.length > 0 ? url.pathname : '/')
}

/** @param {unknown} input @returns {string | undefined} */
function extractFetchUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null) {
    const url = /** @type {Record<string, unknown>} */ (input).url
    if (typeof url === 'string') return url
    const href = /** @type {Record<string, unknown>} */ (input).href
    if (typeof href === 'string') return href
  }
  return undefined
}

/**
 * @param {string | undefined} raw
 * @returns {{ host: string, port: number | undefined, url: string } | undefined}
 */
export function describeUrl(raw) {
  if (raw === undefined) return undefined
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const port = parsed.port.length > 0 ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol)
  return { host: normalizeHost(parsed.hostname), port, url: sanitizeUrl(parsed) }
}

/**
 * @param {ProviderGuardConfig} config
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function createPolicy(config, ctx) {
  const audit = createAuditLog(config.auditLog)
  const startedAt = new Date().toISOString()
  const recent = []
  const stats = { checks: 0, rerouted: 0, blocked: 0, autoSwitchBlocked: 0, hostBlocked: 0, foreignCalls: 0 }
  const lastWarnAt = new Map()
  /** @type {Selection | undefined} */
  let active
  /** @type {Map<string, Selection>} */
  const activeBySession = new Map()
  let installed = false
  /** @type {typeof globalThis.fetch | undefined} */
  let savedFetch
  /** @type {typeof net.Socket.prototype.connect | undefined} */
  let savedConnect
  /** @type {typeof globalThis.fetch | undefined} */
  let patchedFetch
  /** @type {typeof net.Socket.prototype.connect | undefined} */
  let patchedConnect

  /** @param {unknown} value */
  function isRecord(value) {
    return typeof value === 'object' && value !== null
  }

  /** @returns {Selection | undefined} */
  function liveSelection() {
    try {
      const service = ctx.get?.('agentDefaultModel')
      const selection = service?.currentSelection?.()
      return isRecord(selection) && typeof selection.provider === 'string' && selection.provider.length > 0
        ? { provider: selection.provider, model: typeof selection.model === 'string' ? selection.model : undefined }
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the provider that governs one call. The live UI selection is the
   * authority; a per-session entry is only honored while it agrees with that
   * selection, so a stale or programmatic switch cannot re-route a session
   * behind the user's back.
   *
   * @param {{ sessionId?: unknown } | undefined} options
   * @returns {Selection | undefined}
   */
  function selectedFor(options) {
    if (config.fallbackProvider !== undefined && !config.followSelection) {
      return { provider: config.fallbackProvider, model: config.fallbackModel }
    }
    const live = liveSelection()
    if (options?.sessionId !== undefined) {
      const key = String(options.sessionId)
      const fromSession = activeBySession.get(key)
      if (fromSession !== undefined && (live === undefined || fromSession.provider === live.provider)) {
        return { provider: fromSession.provider, model: config.fallbackModel ?? fromSession.model }
      }
    }
    if (live !== undefined) return { provider: live.provider, model: config.fallbackModel ?? live.model }
    if (active !== undefined) return { provider: active.provider, model: config.fallbackModel ?? active.model }
    if (config.fallbackProvider !== undefined) {
      return { provider: config.fallbackProvider, model: config.fallbackModel }
    }
    return undefined
  }

  /** @param {{ provider?: unknown, model?: unknown, sessionId?: unknown }} options */
  function remember(options) {
    if (typeof options.provider !== 'string' || options.provider.length === 0) return
    const selection = {
      provider: options.provider,
      ...typeof options.model === 'string' && options.model.length > 0 ? { model: options.model } : {},
    }
    active = selection
    if (options.sessionId !== undefined) {
      const key = String(options.sessionId)
      activeBySession.delete(key)
      activeBySession.set(key, selection)
      if (activeBySession.size > 500) {
        const oldest = activeBySession.keys().next().value
        if (oldest !== undefined) activeBySession.delete(oldest)
      }
    }
  }

  /** @param {string | undefined} provider */
  function hostsFor(provider) {
    if (provider === undefined) return []
    const configured = config.providerHosts[provider]
    if (configured !== undefined) return configured
    return PROVIDER_HOSTS[provider] ?? []
  }

  /**
   * Return the provider id that owns `host`, excluding the selected provider
   * and any host the selected provider also claims.
   *
   * @param {string} host
   * @param {Selection | undefined} selected
   * @returns {string | undefined}
   */
  function foreignOwner(host, selected) {
    const selectedHosts = hostsFor(selected?.provider)
    if (hostMatchesAny(host, selectedHosts)) return undefined
    for (const [provider, hosts] of Object.entries({ ...PROVIDER_HOSTS, ...config.providerHosts })) {
      if (provider === selected?.provider) continue
      if (hostMatchesAny(host, hosts)) return provider
    }
    return undefined
  }

  /**
   * Decide one host. Ordinary hosts pass; only another model provider's
   * endpoint is denied.
   *
   * @param {string} host
   * @param {number | undefined} port
   * @param {object} [extra]
   * @returns {{ allowed: boolean, reason: string, foreignProvider?: string, selected?: Selection }}
   */
  function hostDecision(host, port, extra) {
    const target = { layer: /** @type {const} */ ('host'), host: normalizeHost(host), port, ...extra }
    if (target.host.length === 0) return { allowed: true, reason: 'empty-host' }
    if (isLoopbackHost(target.host) && config.allowLoopback) return { allowed: true, reason: 'loopback' }
    if (isPrivateHost(target.host) && config.allowPrivateNetwork) return { allowed: true, reason: 'private-network' }
    const selected = selectedFor(undefined)
    if (selected === undefined) return { allowed: true, reason: 'no-selection' }
    if (hostMatchesAny(target.host, hostsFor(selected.provider))) {
      return { allowed: true, reason: 'selected-provider', selected }
    }
    if (!config.blockForeignProviderHosts) return { allowed: true, reason: 'host-blocking-off', selected }
    const owner = foreignOwner(target.host, selected)
    if (owner !== undefined) {
      return { allowed: false, reason: 'foreign-provider-host', foreignProvider: owner, selected }
    }
    return { allowed: true, reason: 'ordinary-host', selected }
  }

  /**
   * Append a user-facing note to a terminal provider failure so the chat says
   * explicitly that no fallback happened. The failure code is preserved, so
   * retry classification is unchanged.
   *
   * @param {AsyncIterable<any>} iterable
   * @returns {AsyncIterable<any>}
   */
  function annotateProviderFailure(iterable) {
    const note = '\n\n[dsh-provider-guard] 不会自动切换或回退到其他供应商；'
      + '如果本轮最终失败，请手动在模型选择器里更换供应商后重试。'
    return (async function* annotated() {
      for await (const chunk of iterable) {
        if (chunk?.type === 'finish'
          && chunk.reason?.kind === 'error'
          && typeof chunk.reason.failure?.message === 'string'
          && !chunk.reason.failure.message.includes('dsh-provider-guard')) {
          yield {
            ...chunk,
            reason: {
              ...chunk.reason,
              failure: { ...chunk.reason.failure, message: chunk.reason.failure.message + note },
            },
          }
        } else {
          yield chunk
        }
      }
    })()
  }

  /** @param {Target} target */
  function stack() {
    const value = new Error().stack
    return value === undefined ? [] : value.split('\n').slice(2, 8).map(line => line.trim())
  }

  /**
   * @param {{ decision: 'blocked' | 'rerouted' | 'allowed', layer: 'llm' | 'host', fromProvider?: string, toProvider?: string, model?: string, host?: string, port?: number, url?: string, reason?: string, enforced?: boolean }} record
   */
  function writeRecord(record) {
    stats.checks += 1
    if (record.decision === 'rerouted') stats.rerouted += 1
    if (record.decision === 'blocked') stats.blocked += 1
    if (record.layer === 'host' && record.decision === 'blocked') stats.hostBlocked += 1
    if (record.decision !== 'allowed') recent.push(record)
    while (recent.length > config.maxRecent) recent.shift()
    if (record.decision === 'allowed' && !config.logAllowed && !String(record.reason ?? '').startsWith('audit-only')) return
    audit.write({
      time: new Date().toISOString(),
      ...record,
      ...record.decision === 'allowed' ? {} : { stack: stack() },
    })
  }

  /** @param {Target} target */
  function mismatchMessage(target) {
    return '[provider-guard] 模型调用供应商 "' + String(target.fromProvider ?? '') + '" 与当前选择 "'
      + String(target.toProvider ?? '') + '" 不一致；这条辅助调用没有按原供应商发出，'
      + (config.onForeignProvider === 'reroute' ? '已改走当前选择的模型。' : '已停止，没有发出这条请求。')
  }

  /** @param {Target & { foreignProvider: string, selected: Selection }} target */
  function hostMessage(target) {
    return '[provider-guard] 已阻止访问 "' + target.host + '"：它属于供应商 "'
      + target.foreignProvider + '"，当前选择是 "' + target.selected.provider + '"。'
      + '这通常是另一家供应商专用的网页搜索/记忆/图片等后台服务，换用当前供应商后不会使用它的 key。'
  }

  /** @param {Target} target */
  function warn(target, message) {
    const key = target.layer + ':' + String(target.host ?? target.fromProvider ?? '')
    const now = Date.now()
    if (now - (lastWarnAt.get(key) ?? 0) < 5000) return
    lastWarnAt.set(key, now)
    console.warn(message)
  }

  /**
   * @param {string | undefined} host
   * @param {number | undefined} port
   * @param {{ url?: string }} [extra]
   */
  function checkHost(host, port, extra = {}) {
    const hostname = normalizeHost(host ?? '')
    const target = { layer: /** @type {const} */ ('host'), host: hostname, port, ...extra }
    const decision = hostDecision(hostname, port, extra)
    if (decision.allowed) {
      if (config.logAllowed) writeRecord({ decision: 'allowed', layer: 'host', host: hostname, port, url: extra.url, reason: decision.reason })
      return
    }
    const full = {
      ...target,
      fromProvider: decision.foreignProvider,
      toProvider: decision.selected?.provider,
    }
    const message = hostMessage({
      ...target,
      foreignProvider: decision.foreignProvider ?? 'unknown',
      selected: decision.selected ?? { provider: 'unknown' },
    })
    if (config.mode === 'audit') {
      writeRecord({ decision: 'allowed', layer: 'host', ...full, reason: 'audit-only:' + decision.reason })
      warn(full, message)
      return
    }
    writeRecord({ decision: 'blocked', layer: 'host', ...full, reason: decision.reason })
    warn(full, message)
    throw new ProviderHostBlockedError(message, full)
  }

  /**
   * Waterfall listener for `llm/stream`.
   *
   * A frozen request without a purpose is the user's main loop. It is allowed
   * only when its provider equals the live UI selection. A mismatch means the
   * harness (or a plugin) tried to switch/fall back on its own, so it is
   * stopped and reported instead of being trusted.
   *
   * @param {any} options
   * @param {() => any} next
   * @returns {any}
   */
  function onStream(options, next) {
    if (options?.[BYPASS] === true) return next()
    const mainLoop = options?.purpose === undefined && Object.isFrozen(options)
    if (mainLoop) {
      const expected = selectedFor(undefined)
      if (config.blockAutoSwitch
        && expected !== undefined
        && typeof options?.provider === 'string'
        && options.provider !== expected.provider) {
        stats.autoSwitchBlocked += 1
        const target = {
          layer: /** @type {const} */ ('llm'),
          fromProvider: options.provider,
          toProvider: expected.provider,
          model: typeof options?.model === 'string' ? options.model : undefined,
        }
        const message = '[provider-guard] 已停止：本会话要使用的模型供应商 "' + options.provider
          + '" 与当前选择 "' + expected.provider + '" 不一致。'
          + 'DSH 不会自动切换、回退或探测其他供应商，也没有发出这条请求。'
          + '请你在模型选择器里手动确认/更换供应商后重试。'
        writeRecord({ decision: 'blocked', ...target, reason: 'auto-switch' })
        warn(target, message)
        throw new ProviderAutoSwitchError(message, target)
      }
      remember(options)
      return annotateProviderFailure(next())
    }

    const selected = selectedFor(options)
    if (selected === undefined) return next()
    if (options?.provider === selected.provider) return next()

    stats.foreignCalls += 1
    const target = {
      layer: /** @type {const} */ ('llm'),
      fromProvider: typeof options?.provider === 'string' ? options.provider : undefined,
      toProvider: selected.provider,
      model: typeof options?.model === 'string' ? options.model : undefined,
    }

    if (config.mode === 'audit' || config.onForeignProvider === 'audit') {
      writeRecord({ decision: 'allowed', ...target, reason: 'audit-only' })
      warn(target, mismatchMessage(target))
      return next()
    }
    if (config.onForeignProvider === 'block') {
      const message = mismatchMessage(target)
      writeRecord({ decision: 'blocked', ...target, reason: 'provider-mismatch' })
      warn(target, message)
      throw new ProviderMismatchError(message, target)
    }

    const model = config.fallbackModel ?? selected.model
    if (model === undefined || model.length === 0) {
      const message = '[provider-guard] 供应商 "' + selected.provider + '" 当前没有可用模型，无法把辅助调用改道。'
      writeRecord({ decision: 'blocked', ...target, reason: 'no-target-model' })
      warn(target, message)
      throw new ProviderMismatchError(message, target)
    }
    const llm = ctx.get?.('llm')
    if (llm?.stream === undefined) {
      const message = '[provider-guard] llm 服务不可用，无法把供应商 "' + String(target.fromProvider) + '" 的调用改道。'
      writeRecord({ decision: 'blocked', ...target, reason: 'llm-unavailable' })
      throw new ProviderMismatchError(message, target)
    }

    const { reasoningEffort: _discard, ...rest } = options
    const clone = { ...rest, provider: selected.provider, model }
    Object.defineProperty(clone, BYPASS, { value: true, enumerable: false })
    active = { provider: selected.provider, model }
    writeRecord({ decision: 'rerouted', ...target, model, reason: 'rerouted-to-selected-provider' })
    return llm.stream(clone)
  }

  function install() {
    if (installed) return
    installed = true

    if (typeof globalThis.fetch === 'function') {
      savedFetch = globalThis.fetch
      patchedFetch = async function guardedFetch(input, init) {
        const target = describeUrl(extractFetchUrl(input))
        if (target !== undefined) checkHost(target.host, target.port, { url: target.url })
        return savedFetch.call(this, input, init)
      }
      globalThis.fetch = patchedFetch
    }

    savedConnect = net.Socket.prototype.connect
    patchedConnect = function guardedConnect(...args) {
      const target = describeConnectTarget(args)
      if (target.kind === 'tcp') checkHost(target.host, target.port)
      return savedConnect.apply(this, args)
    }
    net.Socket.prototype.connect = patchedConnect
  }

  function dispose() {
    if (!installed) return
    if (savedFetch !== undefined && patchedFetch !== undefined && globalThis.fetch === patchedFetch) {
      globalThis.fetch = savedFetch
    }
    if (savedConnect !== undefined && patchedConnect !== undefined && net.Socket.prototype.connect === patchedConnect) {
      net.Socket.prototype.connect = savedConnect
    }
    installed = false
    savedFetch = undefined
    savedConnect = undefined
    patchedFetch = undefined
    patchedConnect = undefined
  }

  function snapshot() {
    const selected = selectedFor(undefined)
    return {
      installed,
      pid: process.pid,
      startedAt,
      mode: config.mode,
      followSelection: config.followSelection,
      onForeignProvider: config.onForeignProvider,
      blockAutoSwitch: config.blockAutoSwitch,
      blockForeignProviderHosts: config.blockForeignProviderHosts,
      selected,
      live: liveSelection(),
      allowedHosts: hostsFor(selected?.provider),
      auditLog: audit.path,
      auditErrors: audit.errors(),
      stats: { ...stats },
      recent: recent.slice(-20).reverse(),
    }
  }

  return { config, install, dispose, onStream, checkHost, hostDecision, selectedFor, snapshot }
}
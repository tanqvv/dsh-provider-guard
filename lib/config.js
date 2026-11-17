/**
 * Configuration for dsh-provider-guard.
 *
 * The guard follows the provider selected in the DSH UI. A deployment may pin
 * a fallback provider for the window before the selection service is readable,
 * but it must not silently allow every provider: that would restore the
 * cross-provider leak this plugin exists to prevent.
 *
 * @module dsh-provider-guard/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { normalizePattern } from './hosts.js'

/** @typedef {'reroute' | 'block' | 'audit'} ForeignProviderPolicy */
/** @typedef {'enforce' | 'audit'} GuardMode */

/**
 * @typedef {object} ProviderGuardConfig
 * @property {string | undefined} fallbackProvider
 * @property {string | undefined} fallbackModel
 * @property {boolean} followSelection
 * @property {ForeignProviderPolicy} onForeignProvider
 * @property {boolean} blockAutoSwitch
 * @property {boolean} blockForeignProviderHosts
 * @property {Record<string, string[]>} providerHosts
 * @property {boolean} allowLoopback
 * @property {boolean} allowPrivateNetwork
 * @property {boolean} allowUnixSockets
 * @property {GuardMode} mode
 * @property {string | null} auditLog
 * @property {boolean} logAllowed
 * @property {number} maxRecent
 */

const DEFAULTS = {
  followSelection: true,
  onForeignProvider: 'block',
  blockAutoSwitch: true,
  blockForeignProviderHosts: true,
  allowLoopback: true,
  allowPrivateNetwork: false,
  allowUnixSockets: true,
  mode: 'enforce',
  logAllowed: false,
  maxRecent: 200,
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {string} key */
function optionalString(value, key) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(key + ' must be a string')
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** @param {unknown} value @param {string} key @param {boolean} fallback */
function booleanValue(value, key, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(key + ' must be true or false')
  return value
}

/** @param {unknown} value @param {string} key @param {number} fallback */
function integerValue(value, key, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(key + ' must be a non-negative integer')
  }
  return value
}

/** @param {string} value */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** @returns {string} */
function defaultDshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.trim().length > 0 ? resolve(expandHome(override)) : join(homedir(), '.dsh')
}

/**
 * Normalize the per-provider host map. Config entries replace the built-in
 * entry for the same provider, which is how a hand-declared gateway supplies
 * its endpoint.
 *
 * @param {unknown} value
 * @returns {Record<string, string[]>}
 */
function hostMap(value) {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('config.providerHosts must be an object of provider -> host list')
  const result = {}
  for (const [provider, hosts] of Object.entries(value)) {
    if (typeof provider !== 'string' || provider.trim().length === 0) {
      throw new Error('config.providerHosts keys must be non-empty provider ids')
    }
    if (!Array.isArray(hosts)) throw new Error('config.providerHosts["' + provider + '"] must be an array of hosts')
    result[provider] = hosts.map(entry => normalizePattern(String(entry)))
  }
  return result
}

/**
 * @param {unknown} raw
 * @returns {ProviderGuardConfig}
 */
export function resolveConfig(raw) {
  if (raw !== undefined && !isRecord(raw)) throw new Error('provider-guard config must be an object')
  const config = /** @type {Record<string, unknown>} */ (raw ?? {})

  const fallbackProvider = optionalString(config.fallbackProvider, 'config.fallbackProvider')
  const fallbackModel = optionalString(config.fallbackModel, 'config.fallbackModel')
  const followSelection = booleanValue(config.followSelection, 'config.followSelection', DEFAULTS.followSelection)
  if (!followSelection && fallbackProvider === undefined) {
    throw new Error('config.followSelection is false, so config.fallbackProvider must name the provider to lock to')
  }

  const onForeignProvider = config.onForeignProvider ?? DEFAULTS.onForeignProvider
  if (onForeignProvider !== 'reroute' && onForeignProvider !== 'block' && onForeignProvider !== 'audit') {
    throw new Error('config.onForeignProvider must be "reroute", "block", or "audit"')
  }

  const mode = config.mode ?? DEFAULTS.mode
  if (mode !== 'enforce' && mode !== 'audit') throw new Error('config.mode must be "enforce" or "audit"')

  let auditLog = null
  const auditSetting = config.auditLog
  if (auditSetting !== false && auditSetting !== null && auditSetting !== undefined && auditSetting !== '') {
    if (typeof auditSetting !== 'string') throw new Error('config.auditLog must be a path string or false')
    const expanded = expandHome(auditSetting.trim())
    if (expanded.length > 0) auditLog = isAbsolute(expanded) ? expanded : resolve(defaultDshHome(), expanded)
  } else if (auditSetting === undefined) {
    auditLog = join(defaultDshHome(), 'provider-guard', 'audit.jsonl')
  }

  return {
    fallbackProvider,
    fallbackModel,
    followSelection,
    onForeignProvider,
    blockAutoSwitch: booleanValue(config.blockAutoSwitch, 'config.blockAutoSwitch', DEFAULTS.blockAutoSwitch),
    blockForeignProviderHosts: booleanValue(
      config.blockForeignProviderHosts,
      'config.blockForeignProviderHosts',
      DEFAULTS.blockForeignProviderHosts,
    ),
    providerHosts: hostMap(config.providerHosts),
    allowLoopback: booleanValue(config.allowLoopback, 'config.allowLoopback', DEFAULTS.allowLoopback),
    allowPrivateNetwork: booleanValue(config.allowPrivateNetwork, 'config.allowPrivateNetwork', DEFAULTS.allowPrivateNetwork),
    allowUnixSockets: booleanValue(config.allowUnixSockets, 'config.allowUnixSockets', DEFAULTS.allowUnixSockets),
    mode,
    auditLog,
    logAllowed: booleanValue(config.logAllowed, 'config.logAllowed', DEFAULTS.logAllowed),
    maxRecent: integerValue(config.maxRecent, 'config.maxRecent', DEFAULTS.maxRecent),
  }
}
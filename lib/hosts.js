/**
 * Host normalization and provider-host matching for dsh-provider-guard.
 *
 * The guard does not police the internet. It only needs to recognize the
 * endpoints that belong to model providers, so it can tell "this is the
 * selected provider's own endpoint" from "this is another provider's endpoint".
 * All other hosts are left alone.
 *
 * @module dsh-provider-guard/hosts
 */

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Lowercase a hostname, strip IPv6 brackets and the trailing root dot.
 * Unicode names become ASCII so a lookalike cannot dodge an ASCII entry.
 *
 * @param {string} host
 * @returns {string}
 */
export function normalizeHost(host) {
  let value = asString(host).trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value.endsWith('.')) value = value.slice(0, -1)
  if (value.length === 0) return ''
  if (/[^\x00-\x7f]/.test(value)) {
    try {
      value = new URL('http://' + value).hostname.toLowerCase()
      if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
      if (value.endsWith('.')) value = value.slice(0, -1)
    } catch {
      // Keep the raw value: an unparsable name cannot match an ASCII entry.
    }
  }
  return value
}

/**
 * Normalize one host entry. A leading "*." makes it a subdomain wildcard.
 *
 * @param {string} pattern
 * @returns {string}
 */
export function normalizePattern(pattern) {
  const raw = asString(pattern).trim()
  if (raw.length === 0) throw new Error('host entry must be a non-empty string')
  if (raw === '*') throw new Error('a bare "*" host entry is not allowed')
  const wildcard = raw.startsWith('*.') || raw.startsWith('.')
  const body = wildcard ? raw.replace(/^\*\.|^\./, '') : raw
  const host = normalizeHost(body)
  if (host.length === 0) throw new Error('host entry "' + raw + '" has no host part')
  if (host.includes('*')) throw new Error('host entry "' + raw + '" may only use a leading "*." wildcard')
  return wildcard ? '*.' + host : host
}

/**
 * @param {string} host normalized host
 * @param {string} pattern normalized pattern
 * @returns {boolean}
 */
export function hostMatchesPattern(host, pattern) {
  if (host.length === 0) return false
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return host.length > suffix.length && host.endsWith(suffix)
  }
  return host === pattern
}

/**
 * @param {string} host
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function hostMatchesAny(host, patterns) {
  const normalized = normalizeHost(host)
  for (const pattern of patterns) {
    if (hostMatchesPattern(normalized, pattern)) return true
  }
  return false
}

/** @param {string} host @returns {number[] | undefined} */
function ipv4Octets(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const value = normalizeHost(host)
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '0.0.0.0' || value === '::' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('::ffff:')) {
    const octets = ipv4Octets(value.slice('::ffff:'.length))
    return octets !== undefined && octets[0] === 127
  }
  const octets = ipv4Octets(value)
  return octets !== undefined && octets[0] === 127
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateHost(host) {
  const value = normalizeHost(host)
  if (isLoopbackHost(value)) return true
  if (value === '::') return true
  const octets = ipv4Octets(value)
  if (octets !== undefined) {
    const [a, b] = octets
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true
  return false
}

/**
 * @param {string} protocol
 * @returns {number | undefined}
 */
export function defaultPortForProtocol(protocol) {
  if (protocol === 'https:' || protocol === 'wss:') return 443
  if (protocol === 'http:' || protocol === 'ws:') return 80
  return undefined
}

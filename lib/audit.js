/**
 * JSONL audit sink for dsh-provider-guard.
 *
 * Best-effort: a full disk or an unwritable path must not turn a routing
 * decision into a crash. The in-memory ring buffer still answers the status
 * tool. The write is synchronous so a process killed right after a block
 * leaves the record behind.
 *
 * @module dsh-provider-guard/audit
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * @typedef {object} AuditRecord
 * @property {string} time
 * @property {'blocked' | 'rerouted' | 'allowed'} decision
 * @property {'llm' | 'host'} layer
 * @property {string} [fromProvider]
 * @property {string} [toProvider]
 * @property {string} [model]
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [url]
 * @property {string} [reason]
 * @property {string[]} [stack]
 */

/**
 * @param {string | null} path
 * @returns {{ write: (record: AuditRecord) => void, errors: () => number, path: string | null }}
 */
export function createAuditLog(path) {
  let prepared = false
  let errors = 0

  function prepare() {
    if (prepared || path === null) return
    prepared = true
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      errors += 1
    }
  }

  return {
    write(record) {
      if (path === null) return
      prepare()
      try {
        appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
      } catch {
        errors += 1
      }
    },
    errors: () => errors,
    path,
  }
}

#!/usr/bin/env node
/**
 * Read-only post-install check for dsh-provider-guard.
 *
 *   node scripts/verify.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')
if (!existsSync(profilesRoot)) {
  console.error('profiles directory not found: ' + profilesRoot)
  process.exit(1)
}
const profiles = readdirSync(profilesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => existsSync(join(profilesRoot, name, 'cordis.patch.yml')))
  .sort()

let installed = 0
for (const profile of profiles) {
  const patchPath = join(profilesRoot, profile, 'cordis.patch.yml')
  const text = readFileSync(patchPath, 'utf8')
  const block = text.match(/# >>> dsh-provider-guard managed block[\s\S]*?# <<< dsh-provider-guard managed block/)
  if (block === null) {
    console.log('[missing] ' + profile)
    if (text.includes('dsh-egress-guard managed block')) console.log('  ! old egress-guard block still present')
    continue
  }
  installed += 1
  const provider = block[0].match(/fallbackProvider:\s*'([^']+)'/)?.[1]
  const model = block[0].match(/fallbackModel:\s*'([^']+)'/)?.[1]
  const mode = block[0].match(/mode:\s*'([^']+)'/)?.[1]
  const entry = block[0].match(/name:\s*'([^']+)'/)?.[1]
  const hosts = [...block[0].matchAll(/^\s+-\s*'([^']+)'\s*$/gm)].map(match => match[1])
  console.log('[installed] ' + profile + ': provider=' + (provider ?? '(follow UI)') + ' mode=' + mode)
  console.log('  entry: ' + entry + (entry !== undefined && existsSync(entry) ? '' : ' (MISSING)'))
  console.log('  fallback: ' + (model ?? '(none)') + '  hosts: ' + (hosts.join(', ') || '(built-in)'))
  const audit = join(dshHome, 'provider-guard', 'audit-' + profile + '.jsonl')
  if (existsSync(audit)) {
    const lines = readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).slice(-3)
    console.log('  audit tail:')
    for (const line of lines) console.log('    ' + line)
  } else {
    console.log('  audit: not created yet (' + audit + ')')
  }
}
console.log(installed > 0 ? '\nOK: ' + installed + ' profile(s) patched.' : '\nNot installed in any profile.')
process.exit(installed > 0 ? 0 : 1)

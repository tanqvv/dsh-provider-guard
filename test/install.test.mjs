import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'install.mjs')

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

function profile(home) {
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true }))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: opencode-go',
    '    model: deepseek-v4.1-flash',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '',
  ].join('\n'))
  return dir
}

test('installer writes the provider block, detects provider/model/hosts, is idempotent, and uninstalls', () => {
  const home = mkdtempSync(join(tmpdir(), 'provider-guard-install-'))
  const dir = profile(home)
  const patchPath = join(dir, 'cordis.patch.yml')
  try {
    const first = run(['--dsh-home', home, '--apply'])
    assert.equal(first.status, 0, first.stderr)
    let patch = readFileSync(patchPath, 'utf8')
    assert.equal((patch.match(/dsh-provider-guard managed block \(generated/g) ?? []).length, 1)
    assert.match(patch, /id: provider-guard/)
    assert.match(patch, /fallbackProvider: 'opencode-go'/)
    assert.match(patch, /fallbackModel: 'deepseek-v4.1-flash'/)
    assert.match(patch, /onForeignProvider: 'block'/)
    assert.match(patch, /blockAutoSwitch: true/)
    assert.match(patch, /opencode\.ai/)
    assert.equal(existsSync(join(home, 'plugins', 'dsh-provider-guard', 'lib', 'index.js')), true)

    const second = run(['--dsh-home', home, '--apply'])
    assert.equal(second.status, 0, second.stderr)
    patch = readFileSync(patchPath, 'utf8')
    assert.equal((patch.match(/dsh-provider-guard managed block \(generated/g) ?? []).length, 1)

    const removed = run(['--dsh-home', home, '--uninstall', '--apply'])
    assert.equal(removed.status, 0, removed.stderr)
    patch = readFileSync(patchPath, 'utf8')
    assert.equal(patch.includes('dsh-provider-guard managed block'), false)
    assert.match(patch, /agent-default-model/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installer replaces the previous dsh-egress-guard block', () => {
  const home = mkdtempSync(join(tmpdir(), 'provider-guard-migrate-'))
  const dir = profile(home)
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, readFileSync(patchPath, 'utf8') + [
    '# >>> dsh-egress-guard managed block (generated) >>>',
    '- insert:',
    '    - id: egress-guard',
    "      name: '/old/index.js'",
    '      config:',
    "        provider: 'opencode-go'",
    '# <<< dsh-egress-guard managed block <<<',
    '',
  ].join('\n'))
  try {
    const result = run(['--dsh-home', home, '--apply'])
    assert.equal(result.status, 0, result.stderr)
    const patch = readFileSync(patchPath, 'utf8')
    assert.equal(patch.includes('egress-guard managed block'), false)
    assert.match(patch, /id: provider-guard/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
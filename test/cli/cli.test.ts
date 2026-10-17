import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { tempDir } from '../helpers/tmp.ts'

const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('cos-notebook', () => {
  it('prints help and the version', () => {
    assert.match(run(['--help']).stdout, /cos-notebook init/)
    assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+\n$/)
  })

  it('init starts a notebook in the given folder', async () => {
    const dir = join(await tempDir(), 'nb')
    const r = run(['init', dir, '--timezone', 'Asia/Tokyo'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Started a notebook in .*nb \(14 files, change ch_[0-9a-z]{8}\)\.\n$/)
    assert.match(readFileSync(join(dir, 'my-rules.md'), 'utf8'), /timezone: Asia\/Tokyo/)
    assert.ok(existsSync(join(dir, '.git')))
    const again = run(['init', dir])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already has notes/)
  })

  it('init uses COS_NOTEBOOK_DIR and COS_NOTEBOOK_TIMEZONE', async () => {
    const dir = join(await tempDir(), 'from-env')
    const r = run(['init'], { COS_NOTEBOOK_DIR: dir, COS_NOTEBOOK_TIMEZONE: 'Europe/Paris' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(join(dir, 'my-rules.md'), 'utf8'), /timezone: Europe\/Paris/)
  })

  it('explains bad input and commands that come later', () => {
    assert.equal(run(['init', '/tmp/x', '--timezone', 'Nowhere/Land']).status, 1)
    assert.equal(run(['bogus']).status, 2)
    const later = run(['serve'])
    assert.equal(later.status, 2)
    assert.match(later.stderr, /milestone 2/)
  })
})

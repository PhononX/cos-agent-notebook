import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FileLock } from '../../src/adapters/local/file-lock.ts'
import { localDirFor, LOCAL_NOTEBOOK as NB } from '../../src/adapters/local/index.ts'
import { refusal } from '../helpers/refusal.ts'
import { tempDir } from '../helpers/tmp.ts'

const lockFile = (dir: string) => join(dir, '.cos-notebook', 'lock')

async function plantLock(dir: string, holder: Record<string, unknown> | string) {
  await mkdir(join(dir, '.cos-notebook'), { recursive: true })
  await writeFile(lockFile(dir), typeof holder === 'string' ? holder : JSON.stringify(holder))
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  })
  return Number(child.stdout)
}

describe('file lock', () => {
  it('lets one holder at a time through, and removes its lock file afterwards', async () => {
    const dir = await tempDir()
    // Two locks on one folder stand for two processes.
    const a = new FileLock(localDirFor(dir))
    const b = new FileLock(localDirFor(dir))
    const order: string[] = []
    let releaseA!: () => void
    const held = new Promise<void>((r) => (releaseA = r))
    const first = a.run(NB, async () => {
      order.push('a start')
      await held
      order.push('a end')
    })
    await new Promise((r) => setTimeout(r, 30))
    const second = b.run(NB, async () => {
      order.push('b')
    })
    await new Promise((r) => setTimeout(r, 80))
    assert.deepEqual(order, ['a start'])
    releaseA()
    await Promise.all([first, second])
    assert.deepEqual(order, ['a start', 'a end', 'b'])
    assert.ok(!existsSync(lockFile(dir)))
  })

  it('refuses as busy after waiting', async () => {
    const dir = await tempDir()
    await plantLock(dir, { token: 'x', pid: process.pid, host: hostname(), at: Date.now() })
    const e = await refusal(new FileLock(localDirFor(dir), { waitMs: 100 }).run(NB, async () => 1))
    assert.equal(e.code, 'busy')
    assert.ok(existsSync(lockFile(dir)), "someone else's lock is left alone")
  })

  it('takes over a lock left by a process that died, or a half-written one', async () => {
    for (const holder of [
      { token: 'gone', pid: deadPid(), host: hostname(), at: Date.now() },
      '{"token": "half',
    ]) {
      const dir = await tempDir()
      await plantLock(dir, holder)
      assert.equal(
        await new FileLock(localDirFor(dir), { waitMs: 100 }).run(NB, async () => 'ran'),
        'ran',
      )
    }
  })

  it('trusts a fresh lock from another computer, and takes over an old one', async () => {
    const dir = await tempDir()
    await plantLock(dir, { token: 'far', pid: 1, host: 'another-host', at: Date.now() })
    const lock = new FileLock(localDirFor(dir), { waitMs: 100, staleMs: 60_000 })
    assert.equal((await refusal(lock.run(NB, async () => 1))).code, 'busy')
    await plantLock(dir, { token: 'far', pid: 1, host: 'another-host', at: Date.now() - 120_000 })
    assert.equal(await lock.run(NB, async () => 'ran'), 'ran')
  })

  it('never removes a lock it no longer holds', async () => {
    const dir = await tempDir()
    await new FileLock(localDirFor(dir)).run(NB, async () => {
      await writeFile(lockFile(dir), JSON.stringify({ token: 'other', pid: 1, host: 'h', at: 0 }))
    })
    assert.match(await readFile(lockFile(dir), 'utf8'), /"other"/)
  })

  it('serializes a real second process', async () => {
    const dir = await tempDir()
    const lockUrl = new URL('../../src/adapters/local/file-lock.ts', import.meta.url).href
    const indexUrl = new URL('../../src/adapters/local/index.ts', import.meta.url).href
    const script = `
      const { FileLock } = await import(${JSON.stringify(lockUrl)})
      const { localDirFor, LOCAL_NOTEBOOK } = await import(${JSON.stringify(indexUrl)})
      await new FileLock(localDirFor(${JSON.stringify(dir)})).run(LOCAL_NOTEBOOK, async () => {
        process.stdout.write('locked\\n')
        await new Promise((r) => setTimeout(r, 400))
        process.stdout.write('done\\n')
      })
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script])
    const exited = new Promise((r) => child.on('exit', r))
    let out = ''
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        if (out.includes('locked')) resolve()
      })
      void exited.then((code) => reject(new Error(`the other process exited (${code}): ${err}`)))
    })
    const ran = await new FileLock(localDirFor(dir)).run(NB, async () => out)
    assert.match(ran, /locked\ndone\n/, 'this process ran only after the other released the lock')
    await exited
  })
})

// One write at a time per notebook, across processes: `cos-notebook serve`, the CLI and a stdio
// MCP server can all run at once. Within a process, an in-process queue; across processes, an
// exclusive lock file in the notebook's hidden service folder. A lock left by a process that
// died is noticed and taken over.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { NotebookError } from '../../domain/errors.ts'
import type { Lock, NotebookRef } from '../../domain/ports.ts'
import { STATE_DIR } from './file-idempotency.ts'
import type { DirFor } from './fs-store.ts'
import { InProcessLock } from './lock.ts'

interface Holder {
  token: string
  pid: number
  host: string
  /** Milliseconds since the epoch. */
  at: number
}

export interface FileLockOptions {
  /** How long to wait for another process before refusing as busy. Default 10 seconds. */
  waitMs?: number
  /** A lock older than this from another computer, or unreadable, counts as abandoned. Default 10 minutes. */
  staleMs?: number
}

export class FileLock implements Lock {
  private readonly dirFor: DirFor
  private readonly inProcess = new InProcessLock()
  private readonly waitMs: number
  private readonly staleMs: number

  constructor(dirFor: DirFor, opts: FileLockOptions = {}) {
    this.dirFor = dirFor
    this.waitMs = opts.waitMs ?? 10_000
    this.staleMs = opts.staleMs ?? 10 * 60_000
  }

  run<T>(notebook: NotebookRef, fn: () => Promise<T>): Promise<T> {
    return this.inProcess.run(notebook, async () => {
      const file = join(this.dirFor(notebook), STATE_DIR, 'lock')
      const token = await this.acquire(file)
      try {
        return await fn()
      } finally {
        await this.release(file, token)
      }
    })
  }

  private async acquire(file: string): Promise<string> {
    const me: Holder = {
      token: randomBytes(8).toString('hex'),
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
    }
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + this.waitMs
    let pause = 20
    for (;;) {
      try {
        await writeFile(file, JSON.stringify(me), { flag: 'wx', mode: 0o600 })
        return me.token
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e
      }
      const raw = await readFile(file, 'utf8').catch(() => null)
      if (raw !== null && this.abandoned(raw)) {
        // Remove it only if it is still the same abandoned lock, not one just taken by another process.
        const again = await readFile(file, 'utf8').catch(() => null)
        if (again === raw) await rm(file, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new NotebookError(
          'busy',
          'The notebook is busy with another change (from another program using it). Try again in a moment.',
        )
      }
      await sleep(pause)
      pause = Math.min(pause * 2, 250)
    }
  }

  private abandoned(raw: string): boolean {
    let holder: Holder
    try {
      holder = JSON.parse(raw) as Holder
    } catch {
      // A lock file that can't be read was left half-written by a crash, or is junk.
      return true
    }
    if (holder.host === hostname() && typeof holder.pid === 'number') {
      try {
        process.kill(holder.pid, 0)
        return false
      } catch (e) {
        // ESRCH: no such process. EPERM: it exists but belongs to someone else.
        return (e as { code?: string }).code === 'ESRCH'
      }
    }
    return Date.now() - (holder.at ?? 0) > this.staleMs
  }

  private async release(file: string, token: string): Promise<void> {
    const raw = await readFile(file, 'utf8').catch(() => null)
    if (raw === null) return
    try {
      if ((JSON.parse(raw) as Holder).token !== token) return
    } catch {
      return
    }
    await rm(file, { force: true })
  }
}

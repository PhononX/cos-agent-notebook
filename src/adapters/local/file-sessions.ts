// When each client last started a session, in the notebook's hidden service folder. Losing it
// only means the next session shows the last day of changes instead of everything since.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NotebookRef, SessionStore } from '../../domain/ports.ts'
import { STATE_DIR } from './file-idempotency.ts'
import type { DirFor } from './fs-store.ts'

export class FileSessionStore implements SessionStore {
  private readonly dirFor: DirFor

  constructor(dirFor: DirFor) {
    this.dirFor = dirFor
  }

  async lastSession(notebook: NotebookRef, client: string): Promise<number | null> {
    return (await this.load(notebook))[client] ?? null
  }

  async setLastSession(notebook: NotebookRef, client: string, at: number): Promise<void> {
    const all = await this.load(notebook)
    all[client] = at
    const dir = join(this.dirFor(notebook), STATE_DIR)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
    await rename(tmp, join(dir, 'sessions.json'))
  }

  private async load(notebook: NotebookRef): Promise<Record<string, number>> {
    try {
      return JSON.parse(
        await readFile(join(this.dirFor(notebook), STATE_DIR, 'sessions.json'), 'utf8'),
      )
    } catch {
      return {}
    }
  }
}

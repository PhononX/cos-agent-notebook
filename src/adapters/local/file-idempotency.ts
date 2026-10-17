// Idempotency records in a small JSON file in the notebook's hidden service folder. Records
// older than a day are dropped on each write. The folder is never committed or exported.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdempotencyRecord, IdempotencyStore, NotebookRef } from '../../domain/ports.ts'
import type { DirFor } from './fs-store.ts'

const TTL_MS = 24 * 60 * 60 * 1000
export const STATE_DIR = '.cos-notebook'

export class FileIdempotencyStore implements IdempotencyStore {
  private readonly dirFor: DirFor

  constructor(dirFor: DirFor) {
    this.dirFor = dirFor
  }

  async get(notebook: NotebookRef, key: string): Promise<IdempotencyRecord | null> {
    return (await this.load(notebook))[key] ?? null
  }

  async put(notebook: NotebookRef, key: string, record: IdempotencyRecord): Promise<void> {
    const all = await this.load(notebook)
    const now = Date.now()
    for (const [k, r] of Object.entries(all)) if (now - r.at > TTL_MS) delete all[k]
    all[key] = record
    const dir = join(this.dirFor(notebook), STATE_DIR)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
    await rename(tmp, join(dir, 'idempotency.json'))
  }

  private async load(notebook: NotebookRef): Promise<Record<string, IdempotencyRecord>> {
    try {
      return JSON.parse(
        await readFile(join(this.dirFor(notebook), STATE_DIR, 'idempotency.json'), 'utf8'),
      )
    } catch {
      return {}
    }
  }
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/** A new empty folder, removed when the test file finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cos-notebook-test-'))
  after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

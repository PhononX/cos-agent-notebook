import assert from 'node:assert/strict'
import { NotebookError } from '../../src/domain/errors.ts'

/** Awaits a call that should be refused and returns the refusal. */
export async function refusal(p: Promise<unknown>): Promise<NotebookError> {
  try {
    await p
  } catch (e) {
    if (e instanceof NotebookError) return e
    throw e
  }
  assert.fail('expected a refusal')
}

// Refusals. Every message says what's wrong and what to do next; `details` carries the data an
// agent needs to retry (candidates with ids, closest names), as fields rather than prose.

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_value'
  | 'not_found'
  | 'ambiguous'
  | 'stale_id'
  | 'close_name'
  | 'secret'
  | 'forbidden'
  | 'conflict'
  | 'idempotency_mismatch'
  | 'not_a_notebook'

export class NotebookError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>
  /** Which operation in an apply_changes call was refused, counting from 0. */
  operation?: number

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'NotebookError'
    this.code = code
    this.details = details
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.operation !== undefined ? { operation: this.operation } : {}),
      ...this.details,
    }
  }
}

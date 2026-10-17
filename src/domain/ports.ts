// What the domain layer needs from the outside world. Local implementations live in
// src/adapters/local; a hosted deployment provides its own. Every call names the notebook.

export type NotebookId = string

export const NOTEBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface FileWrite {
  path: string
  /** null deletes the file. */
  content: string | null
}

/** The notebook's Markdown files. */
export interface NotebookStore {
  exists(notebook: NotebookId): Promise<boolean>
  /** Makes an empty notebook. */
  create(notebook: NotebookId): Promise<void>
  /** Every note's path, relative to the notebook, with `/`. Hidden folders are left out. */
  list(notebook: NotebookId): Promise<string[]>
  read(notebook: NotebookId, path: string): Promise<string | null>
  /** Writes each file atomically (all of a batch, or the caller restores what was written). */
  write(notebook: NotebookId, files: readonly FileWrite[]): Promise<void>
}

export interface Author {
  name: string
  email: string
}

export interface FileVersion {
  path: string
  before: string | null
  after: string | null
}

export interface ChangeRecord {
  changeId: string
  summary: string
  author: Author
  /** ISO 8601 */
  time: string
  files: FileVersion[]
}

/** The notebook's history: one entry per change. */
export interface History {
  init(notebook: NotebookId): Promise<void>
  /** Records the given paths as they are now in the store, as one change. */
  commit(
    notebook: NotebookId,
    change: { changeId: string; summary: string; author: Author; paths: readonly string[] },
  ): Promise<void>
  findChange(notebook: NotebookId, changeId: string): Promise<ChangeRecord | null>
  /** Earlier versions of the files changed by the most recent changes, newest first. */
  recentVersions(
    notebook: NotebookId,
    changes: number,
  ): Promise<{ path: string; content: string }[]>
  /** Three-way merge of one file's text: the change from `base` to `theirs`, applied to `ours`. */
  merge(base: string, ours: string, theirs: string): Promise<{ text: string; conflict: boolean }>
}

/** Serializes writes to one notebook. */
export interface Lock {
  run<T>(notebook: NotebookId, fn: () => Promise<T>): Promise<T>
}

export interface IdempotencyRecord {
  requestHash: string
  result: unknown
  /** Milliseconds since the epoch. */
  at: number
}

export interface IdempotencyStore {
  get(notebook: NotebookId, key: string): Promise<IdempotencyRecord | null>
  put(notebook: NotebookId, key: string, record: IdempotencyRecord): Promise<void>
}

export interface Clock {
  now(): Date
}

/**
 * Operational logs. Fields carry ids, counts and timings only, never note text: an error's
 * message can hold note text, so log its code, not its message.
 */
export type LogFields = Record<string, string | number | boolean | undefined>

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export const systemClock: Clock = { now: () => new Date() }

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

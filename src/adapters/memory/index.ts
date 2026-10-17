// In-memory implementations of the ports, for tests and for embedding the domain layer
// without a disk. Nothing here survives the process.

import type {
  Author,
  ChangeRecord,
  FileWrite,
  History,
  IdempotencyRecord,
  IdempotencyStore,
  Lock,
  NotebookId,
  NotebookStore,
} from '../../domain/ports.ts'

export class MemoryStore implements NotebookStore {
  readonly notebooks = new Map<NotebookId, Map<string, string>>()
  /** When set, the next write fails after writing this many files (for rollback tests). */
  failAfter: number | null = null

  async exists(notebook: NotebookId) {
    return this.notebooks.has(notebook)
  }
  async create(notebook: NotebookId) {
    if (!this.notebooks.has(notebook)) this.notebooks.set(notebook, new Map())
  }
  async list(notebook: NotebookId) {
    return [...(this.notebooks.get(notebook)?.keys() ?? [])].sort()
  }
  async read(notebook: NotebookId, path: string) {
    return this.notebooks.get(notebook)?.get(path) ?? null
  }
  async write(notebook: NotebookId, files: readonly FileWrite[]) {
    const nb = this.notebooks.get(notebook)
    if (!nb) throw new Error('no such notebook')
    let n = 0
    for (const f of files) {
      if (this.failAfter !== null && n >= this.failAfter) {
        this.failAfter = null
        throw new Error('disk full')
      }
      if (f.content === null) nb.delete(f.path)
      else nb.set(f.path, f.content)
      n++
    }
  }
}

interface MemoryCommit extends ChangeRecord {
  snapshot: Map<string, string>
}

/** History kept as snapshots. Its merge only handles the simple case where nothing else changed. */
export class MemoryHistory implements History {
  readonly commits = new Map<NotebookId, MemoryCommit[]>()
  private readonly baseline = new Map<NotebookId, Map<string, string>>()
  private readonly store: MemoryStore

  constructor(store: MemoryStore) {
    this.store = store
  }

  /** Starts history from whatever the store holds now. */
  async init(notebook: NotebookId) {
    this.commits.set(notebook, [])
    this.baseline.set(notebook, new Map(this.store.notebooks.get(notebook) ?? []))
  }

  async commit(
    notebook: NotebookId,
    change: { changeId: string; summary: string; author: Author; paths: readonly string[] },
  ) {
    const list = this.commits.get(notebook)!
    const prev = list.at(-1)?.snapshot ?? this.baseline.get(notebook) ?? new Map<string, string>()
    const snapshot = new Map(this.store.notebooks.get(notebook)!)
    list.push({
      changeId: change.changeId,
      summary: change.summary,
      author: change.author,
      time: new Date().toISOString(),
      files: change.paths.map((path) => ({
        path,
        before: prev.get(path) ?? null,
        after: snapshot.get(path) ?? null,
      })),
      snapshot,
    })
  }

  async findChange(notebook: NotebookId, changeId: string) {
    const c = this.commits.get(notebook)?.find((x) => x.changeId === changeId)
    if (!c) return null
    const { snapshot: _s, ...record } = c
    return record
  }

  async recentVersions(notebook: NotebookId, changes: number) {
    const list = this.commits.get(notebook) ?? []
    const out: { path: string; content: string }[] = []
    for (const c of list.slice(-changes).reverse()) {
      for (const f of c.files) if (f.before !== null) out.push({ path: f.path, content: f.before })
    }
    return out
  }

  async merge(base: string, ours: string, theirs: string) {
    if (ours === base) return { text: theirs, conflict: false }
    if (theirs === base) return { text: ours, conflict: false }
    return { text: ours, conflict: true }
  }
}

export class MemoryLock implements Lock {
  private readonly tails = new Map<NotebookId, Promise<unknown>>()

  run<T>(notebook: NotebookId, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(notebook) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.tails.set(
      notebook,
      next.catch(() => undefined),
    )
    return next
  }
}

export class MemoryIdempotency implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>()

  async get(notebook: NotebookId, key: string) {
    return this.records.get(`${notebook}\n${key}`) ?? null
  }
  async put(notebook: NotebookId, key: string, record: IdempotencyRecord) {
    this.records.set(`${notebook}\n${key}`, record)
  }
}

// In-memory implementations of the ports, for tests and for embedding the domain layer
// without a disk. Nothing here survives the process.

import type {
  Author,
  ChangeRecord,
  Clock,
  FileWrite,
  History,
  IdempotencyRecord,
  IdempotencyStore,
  NotebookRef,
  NotebookStore,
  SessionStore,
} from '../../domain/ports.ts'
import { notebookKey } from '../../domain/notebook-ref.ts'

export class MemoryStore implements NotebookStore {
  /** Each notebook's files, by notebookKey: spaces never share an entry. */
  readonly notebooks = new Map<string, Map<string, string>>()
  /** When set, the next write fails after writing this many files (for rollback tests). */
  failAfter: number | null = null

  async exists(notebook: NotebookRef) {
    return this.notebooks.has(notebookKey(notebook))
  }
  async create(notebook: NotebookRef) {
    if (!this.notebooks.has(notebookKey(notebook)))
      this.notebooks.set(notebookKey(notebook), new Map())
  }
  async list(notebook: NotebookRef) {
    return [...(this.notebooks.get(notebookKey(notebook))?.keys() ?? [])].sort()
  }
  async read(notebook: NotebookRef, path: string) {
    return this.notebooks.get(notebookKey(notebook))?.get(path) ?? null
  }
  async write(notebook: NotebookRef, files: readonly FileWrite[]) {
    const nb = this.notebooks.get(notebookKey(notebook))
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
  readonly commits = new Map<string, MemoryCommit[]>()
  private readonly baseline = new Map<string, Map<string, string>>()
  private readonly store: MemoryStore
  private readonly clock: Clock

  constructor(store: MemoryStore, clock: Clock = { now: () => new Date() }) {
    this.store = store
    this.clock = clock
  }

  commitsOf(notebook: NotebookRef): ChangeRecord[] {
    return this.commits.get(notebookKey(notebook)) ?? []
  }

  /** Starts history from whatever the store holds now. */
  async init(notebook: NotebookRef) {
    this.commits.set(notebookKey(notebook), [])
    this.baseline.set(
      notebookKey(notebook),
      new Map(this.store.notebooks.get(notebookKey(notebook)) ?? []),
    )
  }

  async commit(
    notebook: NotebookRef,
    change: { changeId: string; summary: string; author: Author; paths: readonly string[] },
  ) {
    const list = this.commits.get(notebookKey(notebook))!
    const prev =
      list.at(-1)?.snapshot ?? this.baseline.get(notebookKey(notebook)) ?? new Map<string, string>()
    const snapshot = new Map(this.store.notebooks.get(notebookKey(notebook))!)
    list.push({
      changeId: change.changeId,
      summary: change.summary,
      author: change.author,
      time: this.clock.now().toISOString(),
      files: change.paths.map((path) => ({
        path,
        before: prev.get(path) ?? null,
        after: snapshot.get(path) ?? null,
      })),
      snapshot,
    })
  }

  async findChange(notebook: NotebookRef, changeId: string) {
    const c = this.commits.get(notebookKey(notebook))?.find((x) => x.changeId === changeId)
    if (!c) return null
    const { snapshot: _s, ...record } = c
    return record
  }

  async state(notebook: NotebookRef) {
    const commits = this.commits.get(notebookKey(notebook))
    return {
      notebook: (commits?.length ?? 0) > 0,
      existingHistory: false,
      insideAnotherRepository: false,
    }
  }

  async outsideChanges(notebook: NotebookRef) {
    const key = notebookKey(notebook)
    const last = this.commits.get(key)?.at(-1)?.snapshot ?? this.baseline.get(key) ?? new Map()
    const now = this.store.notebooks.get(key) ?? new Map<string, string>()
    const paths = new Set([...last.keys(), ...now.keys()])
    return [...paths].filter((p) => last.get(p) !== now.get(p)).sort()
  }

  async listChanges(notebook: NotebookRef, opts: { limit: number; offset?: number }) {
    const list = [...(this.commits.get(notebookKey(notebook)) ?? [])].reverse()
    return list.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit).map((c) => ({
      changeId: c.changeId,
      summary: c.summary,
      author: c.author,
      time: c.time,
      paths: c.files.map((f) => f.path),
    }))
  }

  async recentVersions(notebook: NotebookRef, changes: number) {
    const list = this.commits.get(notebookKey(notebook)) ?? []
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

export { InProcessLock as MemoryLock } from '../local/lock.ts'

export class MemorySessions implements SessionStore {
  private readonly last = new Map<string, number>()

  async lastSession(notebook: NotebookRef, client: string) {
    return this.last.get(`${notebookKey(notebook)}\n${client}`) ?? null
  }
  async setLastSession(notebook: NotebookRef, client: string, at: number) {
    this.last.set(`${notebookKey(notebook)}\n${client}`, at)
  }
}

export class MemoryIdempotency implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>()

  async get(notebook: NotebookRef, key: string) {
    return this.records.get(`${notebookKey(notebook)}\n${key}`) ?? null
  }
  async put(notebook: NotebookRef, key: string, record: IdempotencyRecord) {
    this.records.set(`${notebookKey(notebook)}\n${key}`, record)
  }
}

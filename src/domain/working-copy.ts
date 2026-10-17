// An in-memory copy of one notebook's notes for the length of one call. Operations edit it;
// nothing reaches the store until every operation has succeeded, so a batch is all or nothing.

import { TextLines } from '../format/lines.ts'
import { parseNote, type Item, type Note } from '../format/note.ts'
import type { NotebookRef, NotebookStore } from './ports.ts'

export interface FileChange {
  path: string
  before: string | null
  after: string | null
}

export class WorkingCopy {
  private readonly notes = new Map<string, Note>()
  private readonly original = new Map<string, string | null>()
  private itemCache: Item[] | null = null

  static async load(store: NotebookStore, notebook: NotebookRef): Promise<WorkingCopy> {
    const copy = new WorkingCopy()
    const paths = await store.list(notebook)
    const texts = await Promise.all(paths.map((p) => store.read(notebook, p)))
    paths.forEach((p, i) => {
      const text = texts[i]
      if (text == null) return
      copy.original.set(p, text)
      copy.notes.set(p, parseNote(p, text))
    })
    return copy
  }

  static fromTexts(texts: Map<string, string>): WorkingCopy {
    const copy = new WorkingCopy()
    for (const [p, t] of texts) {
      copy.original.set(p, t)
      copy.notes.set(p, parseNote(p, t))
    }
    return copy
  }

  paths(): string[] {
    return [...this.notes.keys()].sort()
  }

  has(path: string): boolean {
    return this.notes.has(path)
  }

  note(path: string): Note | undefined {
    return this.notes.get(path)
  }

  items(): Item[] {
    this.itemCache ??= [...this.notes.values()].flatMap((n) => n.items)
    return this.itemCache
  }

  findById(id: string): Item | undefined {
    return this.items().find((i) => i.id === id)
  }

  create(path: string, lines: readonly string[]): Note {
    if (this.notes.has(path)) throw new Error(`${path} already exists`)
    if (!this.original.has(path)) this.original.set(path, null)
    return this.set(path, TextLines.from([...lines]))
  }

  /** Replaces lines in a note and returns the lines it removed. */
  splice(path: string, start: number, count: number, lines: readonly string[]): string[] {
    const note = this.notes.get(path)
    if (!note) throw new Error(`${path} doesn't exist`)
    const removed = note.text.lines().slice(start, start + count)
    this.set(path, note.text.splice(start, count, lines))
    return removed
  }

  /** Replaces a whole note's text (undo). null deletes it. */
  replace(path: string, text: string | null): void {
    if (!this.original.has(path)) this.original.set(path, null)
    if (text === null) {
      this.notes.delete(path)
      this.itemCache = null
    } else {
      this.set(path, TextLines.parse(text))
    }
  }

  changes(): FileChange[] {
    const out: FileChange[] = []
    for (const [path, before] of this.original) {
      const note = this.notes.get(path)
      const after = note ? note.text.toString() : null
      if (after !== before) out.push({ path, before, after })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  private set(path: string, text: TextLines): Note {
    const note = parseNote(path, text)
    this.notes.set(path, note)
    this.itemCache = null
    return note
  }
}

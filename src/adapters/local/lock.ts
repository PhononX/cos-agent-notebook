import { notebookKey } from '../../domain/notebook-ref.ts'
import type { Lock, NotebookRef } from '../../domain/ports.ts'

/** One write at a time per notebook, within this process. */
export class InProcessLock implements Lock {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(notebook: NotebookRef, fn: () => Promise<T>): Promise<T> {
    const key = notebookKey(notebook)
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }
}

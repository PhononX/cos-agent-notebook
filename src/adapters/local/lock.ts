import type { Lock, NotebookId } from '../../domain/ports.ts'

/** One write at a time per notebook, within this process. */
export class InProcessLock implements Lock {
  private readonly tails = new Map<NotebookId, Promise<unknown>>()

  run<T>(notebook: NotebookId, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(notebook) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.tails.set(notebook, tail)
    void tail.then(() => {
      if (this.tails.get(notebook) === tail) this.tails.delete(notebook)
    })
    return next
  }
}

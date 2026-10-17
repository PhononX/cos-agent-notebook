// Notebooks as folders on local disk. Each file is written to a temporary file in the same
// folder and renamed into place, so a reader never sees half a file.

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathProblem } from '../../format/layout.ts'
import type { FileWrite, NotebookRef, NotebookStore } from '../../domain/ports.ts'

export type DirFor = (notebook: NotebookRef) => string

export class LocalNotebookStore implements NotebookStore {
  private readonly dirFor: DirFor

  constructor(dirFor: DirFor) {
    this.dirFor = dirFor
  }

  async exists(notebook: NotebookRef): Promise<boolean> {
    try {
      return (await lstat(this.dirFor(notebook))).isDirectory()
    } catch {
      return false
    }
  }

  async create(notebook: NotebookRef): Promise<void> {
    await mkdir(this.dirFor(notebook), { recursive: true })
  }

  async list(notebook: NotebookRef): Promise<string[]> {
    const root = this.dirFor(notebook)
    const out: string[] = []
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        // Hidden files and folders (.git, draft history, service state) aren't notes, and
        // symbolic links are never followed out of the notebook.
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile() && e.name.endsWith('.md'))
          out.push(relative(root, full).split(sep).join('/'))
      }
    }
    await walk(root)
    return out.sort()
  }

  async read(notebook: NotebookRef, path: string): Promise<string | null> {
    const full = this.resolve(notebook, path)
    try {
      if (!(await lstat(full)).isFile()) return null
      return await readFile(full, 'utf8')
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }

  async write(notebook: NotebookRef, files: readonly FileWrite[]): Promise<void> {
    for (const f of files) {
      const full = this.resolve(notebook, f.path)
      if (f.content === null) {
        await rm(full, { force: true })
        continue
      }
      await mkdir(dirname(full), { recursive: true })
      const tmp = join(dirname(full), `.${randomBytes(6).toString('hex')}.tmp`)
      try {
        await writeFile(tmp, f.content, { encoding: 'utf8', mode: 0o600 })
        await rename(tmp, full)
      } catch (e) {
        await rm(tmp, { force: true })
        throw e
      }
    }
  }

  /** The file for a note path, refusing anything outside the notebook. */
  private resolve(notebook: NotebookRef, path: string): string {
    const problem = pathProblem(path)
    if (problem) throw new Error(`Refused a path that ${problem}`)
    const root = resolve(this.dirFor(notebook))
    const full = resolve(root, ...path.split('/'))
    if (!full.startsWith(root + sep)) throw new Error('Refused a path outside the notebook')
    return full
  }
}

function isNotFound(e: unknown): boolean {
  return (
    !!e && typeof e === 'object' && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
  )
}

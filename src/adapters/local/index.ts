// Wires the domain layer to local disk and git. Two layouts:
//
// - `dir`: one person's single notebook (local mode), `personal:local:default`, kept in that folder.
// - `root`: many notebooks, with personal and workspace spaces in separate folder trees:
//   `<root>/personal/<account>/<id>/` and `<root>/workspaces/<workspace>/<id>/`. Each notebook is
//   its own folder and git repository, so a space can be backed up, moved or deleted on its own.

import { join, resolve } from 'node:path'
import { notebookKey, personalNotebook, sameNotebook } from '../../domain/notebook-ref.ts'
import type { Clock, Logger, NotebookRef } from '../../domain/ports.ts'
import { NotebookService } from '../../domain/service.ts'
import { FileIdempotencyStore } from './file-idempotency.ts'
import { LocalNotebookStore, type DirFor } from './fs-store.ts'
import { GitHistory } from './git-history.ts'
import { FileLock } from './file-lock.ts'
import { InProcessLock } from './lock.ts'
import { JsonLogger } from './logger.ts'

export const LOCAL_NOTEBOOK: NotebookRef = personalNotebook('local')

export type LocalOptions = (
  { dir: string; root?: undefined } | { root: string; dir?: undefined }
) & {
  defaultTimezone?: string
  logger?: Logger
  clock?: Clock
}

/** One notebook in one folder. */
export function localDirFor(dir: string): DirFor {
  const folder = resolve(dir)
  return (notebook) => {
    if (!sameNotebook(notebook, LOCAL_NOTEBOOK)) {
      throw new Error('This folder holds one notebook, personal:local:default')
    }
    return folder
  }
}

/** Every notebook under one root, each space in its own folder tree. */
export function segmentedDirFor(root: string): DirFor {
  const base = resolve(root)
  // notebookKey checks every part is a safe id, so the result is always inside the root.
  return (notebook) => join(base, ...notebookKey(notebook).split('/'))
}

export function createLocalService(opts: LocalOptions): NotebookService {
  const dirFor = opts.root !== undefined ? segmentedDirFor(opts.root) : localDirFor(opts.dir)
  return new NotebookService({
    store: new LocalNotebookStore(dirFor),
    history: new GitHistory(dirFor),
    lock: new FileLock(dirFor),
    idempotency: new FileIdempotencyStore(dirFor),
    logger: opts.logger ?? new JsonLogger(),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.defaultTimezone ? { defaultTimezone: opts.defaultTimezone } : {}),
  })
}

export { FileIdempotencyStore, FileLock, GitHistory, InProcessLock, JsonLogger, LocalNotebookStore }

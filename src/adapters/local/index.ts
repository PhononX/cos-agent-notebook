// Wires the domain layer to local disk and git for one person's notebook. Local mode has one
// notebook, `default`, kept in the folder given; every call still names it.

import { resolve } from 'node:path'
import type { Clock, Logger, NotebookId } from '../../domain/ports.ts'
import { NotebookService } from '../../domain/service.ts'
import { FileIdempotencyStore } from './file-idempotency.ts'
import { LocalNotebookStore, type DirFor } from './fs-store.ts'
import { GitHistory } from './git-history.ts'
import { InProcessLock } from './lock.ts'
import { JsonLogger } from './logger.ts'

export const LOCAL_NOTEBOOK: NotebookId = 'default'

export interface LocalOptions {
  /** The notebook's folder. */
  dir: string
  defaultTimezone?: string
  logger?: Logger
  clock?: Clock
}

export function localDirFor(dir: string): DirFor {
  const root = resolve(dir)
  return (notebook) => {
    if (notebook !== LOCAL_NOTEBOOK) throw new Error('Local mode has one notebook, "default"')
    return root
  }
}

export function createLocalService(opts: LocalOptions): NotebookService {
  const dirFor = localDirFor(opts.dir)
  return new NotebookService({
    store: new LocalNotebookStore(dirFor),
    history: new GitHistory(dirFor),
    lock: new InProcessLock(),
    idempotency: new FileIdempotencyStore(dirFor),
    logger: opts.logger ?? new JsonLogger(),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.defaultTimezone ? { defaultTimezone: opts.defaultTimezone } : {}),
  })
}

export { FileIdempotencyStore, GitHistory, InProcessLock, JsonLogger, LocalNotebookStore }

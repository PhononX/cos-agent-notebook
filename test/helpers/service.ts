import {
  MemoryHistory,
  MemoryIdempotency,
  MemoryLock,
  MemoryStore,
} from '../../src/adapters/memory/index.ts'
import type { Actor } from '../../src/domain/actor.ts'
import { personalNotebook } from '../../src/domain/notebook-ref.ts'
import type { LogFields, Logger } from '../../src/domain/ports.ts'
import { NotebookService } from '../../src/domain/service.ts'
import { fixtureNotes } from './fixture.ts'

/** 10:05 on Saturday 2026-10-17 in New York, the fixture's time zone. */
export const NOW = new Date('2026-10-17T14:05:00Z')
export const TODAY = '2026-10-17'
export const NB = personalNotebook('alex')
export const AGENT: Actor = { client: 'claude-desktop', person: 'Alex', source: 'cv' }

export class CaptureLogger implements Logger {
  readonly lines: string[] = []
  info(event: string, fields?: LogFields) {
    this.lines.push(JSON.stringify({ level: 'info', event, ...fields }))
  }
  warn(event: string, fields?: LogFields) {
    this.lines.push(JSON.stringify({ level: 'warn', event, ...fields }))
  }
  error(event: string, fields?: LogFields) {
    this.lines.push(JSON.stringify({ level: 'error', event, ...fields }))
  }
}

/** A service over an in-memory copy of the fixture notebook, with a fixed clock. */
export async function fixtureService(opts: { now?: Date } = {}) {
  const store = new MemoryStore()
  const history = new MemoryHistory(store)
  const logger = new CaptureLogger()
  const clock = { now: () => opts.now ?? NOW }
  const service = new NotebookService({
    store,
    history,
    lock: new MemoryLock(),
    idempotency: new MemoryIdempotency(),
    clock,
    logger,
    defaultTimezone: 'UTC',
  })
  await store.create(NB)
  await store.write(
    NB,
    [...fixtureNotes()].map(([path, content]) => ({ path, content })),
  )
  await history.init(NB)
  const read = async (path: string) => (await store.read(NB, path)) ?? ''
  const apply = (
    operations: unknown[],
    extra: Record<string, unknown> = {},
    actor: Actor = AGENT,
  ) => service.applyChanges(NB, { operations, ...extra }, actor)
  return { service, store, history, logger, read, apply }
}

// The domain layer's front door. HTTP, MCP and the CLI call these methods and nothing else, so
// every change gets the same checks, provenance and history however it arrives.

import { createHash } from 'node:crypto'
import { renderFrontMatterEntry, frontMatterValue } from '../format/front-matter.ts'
import { CHANGE_ID, newChangeId } from '../format/ids.ts'
import { STARTER_FILES, logPath, newNoteLines, pathProblem } from '../format/layout.ts'
import { parseNote, type Item } from '../format/note.ts'
import { isTimeZone } from '../format/values.ts'
import { actorAuthor, actorLabel, checkActor, hasScope, type Actor } from './actor.ts'
import {
  Batch,
  candidate,
  type Candidate,
  type OpResult,
  type StaleItem,
  type Warning,
} from './batch.ts'
import { renderChecked } from './compose.ts'
import { NotebookError } from './errors.ts'
import { runOperation } from './operations.ts'
import {
  NOTEBOOK_ID,
  silentLogger,
  systemClock,
  type Clock,
  type History,
  type IdempotencyStore,
  type Lock,
  type Logger,
  type NotebookId,
  type NotebookStore,
} from './ports.ts'
import { parseRequest } from './request.ts'
import { normalize, textSimilarity } from './similarity.ts'
import { systemTimeZone, zonedNow, type ZonedNow } from './time.ts'
import { WorkingCopy, type FileChange } from './working-copy.ts'

export interface ServiceDeps {
  store: NotebookStore
  history: History
  lock: Lock
  idempotency: IdempotencyStore
  clock?: Clock
  logger?: Logger
  /** The time zone for notebooks whose my-rules.md doesn't set one. */
  defaultTimezone?: string
}

export interface FileSummary {
  path: string
  status: 'created' | 'changed' | 'deleted'
}

export interface ApplyChangesResult {
  change_id: string | null
  dry_run: boolean
  /** True when this is the stored result of an earlier call with the same idempotency key. */
  replayed: boolean
  summary: string
  results: OpResult[]
  new_names: string[]
  files: FileSummary[]
  warnings: Warning[]
}

export interface UndoResult {
  change_id: string
  undone: string
  summary: string
  files: FileSummary[]
}

export interface CompactItem {
  id: string
  file: string
  text: string
  done: boolean | null
  fields: Record<string, string | string[]>
  links: string[]
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const STALE_SEARCH_CHANGES = 30

export class NotebookService {
  private readonly store: NotebookStore
  private readonly history: History
  private readonly lock: Lock
  private readonly idempotency: IdempotencyStore
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly defaultTimezone: string

  constructor(deps: ServiceDeps) {
    this.store = deps.store
    this.history = deps.history
    this.lock = deps.lock
    this.idempotency = deps.idempotency
    this.clock = deps.clock ?? systemClock
    this.logger = deps.logger ?? silentLogger
    this.defaultTimezone = deps.defaultTimezone ?? systemTimeZone()
  }

  // ---------- notebooks ----------

  /** Starts a notebook with the starter files and its first history entry. */
  async init(
    notebook: NotebookId,
    opts: { actor: Actor; timezone?: string },
  ): Promise<{ change_id: string; files: string[] }> {
    checkNotebookId(notebook)
    const actor = checkActor(opts.actor)
    const timezone = opts.timezone ?? this.defaultTimezone
    if (!isTimeZone(timezone)) {
      throw new NotebookError(
        'invalid_value',
        `"${timezone}" isn't a time zone; use an IANA name like Europe/Berlin.`,
      )
    }
    return this.lock.run(notebook, async () => {
      if ((await this.store.exists(notebook)) && (await this.store.list(notebook)).length > 0) {
        throw new NotebookError(
          'conflict',
          'This folder already has notes in it, so nothing was changed. Choose an empty or new folder.',
        )
      }
      await this.store.create(notebook)
      await this.history.init(notebook)
      const copy = WorkingCopy.fromTexts(new Map())
      for (const path of STARTER_FILES) {
        let lines = newNoteLines(path)
        if (path === 'my-rules.md') {
          const settings: [string, string][] = [
            ['timezone', timezone],
            ['nudges_per_day', '3'],
            ['stale_days', '30'],
            ['meeting_prep', 'offer'],
          ]
          lines = [
            '---',
            ...settings.map(([k, v]) => renderFrontMatterEntry(k, v)),
            '---',
            ...lines,
          ]
        }
        copy.create(path, lines)
      }
      const now = zonedNow(this.clock.now(), timezone)
      const changeId = newChangeId()
      const files = await this.commit(notebook, copy, {
        changeId,
        summary: 'Started the notebook',
        actor,
        now,
      })
      this.logger.info('notebook_init', { notebook, change_id: changeId, files: files.length })
      return { change_id: changeId, files: files.map((f) => f.path) }
    })
  }

  // ---------- reads ----------

  async readNote(notebook: NotebookId, path: string) {
    checkNotebookId(notebook)
    const problem = pathProblem(path)
    if (problem) throw new NotebookError('invalid_value', `The path "${path}" ${problem}.`)
    await this.requireNotebook(notebook)
    const text = await this.store.read(notebook, path)
    if (text === null) throw new NotebookError('not_found', `There is no note ${path}.`)
    const note = parseNote(path, text)
    return {
      path,
      type: note.type,
      front_matter: Object.fromEntries(
        (note.frontMatter?.entries ?? []).map((e) => [e.key, e.value]),
      ),
      items: note.items.map(compactItem),
      problems: note.problems.map(({ line, message }) => ({ line, message })),
      text,
    }
  }

  async listItems(notebook: NotebookId, opts: { file?: string } = {}): Promise<CompactItem[]> {
    checkNotebookId(notebook)
    await this.requireNotebook(notebook)
    const copy = await WorkingCopy.load(this.store, notebook)
    return copy
      .items()
      .filter((i) => opts.file === undefined || i.path === opts.file)
      .map(compactItem)
  }

  /** The notebook's time zone and today's date in it. */
  async today(notebook: NotebookId): Promise<ZonedNow> {
    checkNotebookId(notebook)
    await this.requireNotebook(notebook)
    const copy = await WorkingCopy.load(this.store, notebook)
    return zonedNow(this.clock.now(), this.timezoneOf(copy).timezone)
  }

  // ---------- writes ----------

  async applyChanges(
    notebook: NotebookId,
    input: unknown,
    actorIn: Actor,
  ): Promise<ApplyChangesResult> {
    const started = Date.now()
    checkNotebookId(notebook)
    const actor = checkActor(actorIn)
    const req = parseRequest(input)
    const { idempotency_key: key, ...rest } = req
    const requestHash = hashRequest({ ...rest, client: actor.client })
    try {
      return await this.lock.run(notebook, async () => {
        await this.requireNotebook(notebook)
        if (key && !req.dry_run) {
          const prior = await this.idempotency.get(notebook, key)
          if (prior && Date.now() - prior.at < IDEMPOTENCY_TTL_MS) {
            if (prior.requestHash !== requestHash) {
              throw new NotebookError(
                'idempotency_mismatch',
                'This idempotency_key was already used for a different request. Use a new key for a new request.',
              )
            }
            this.logger.info('apply_changes_replayed', { notebook })
            return { ...(prior.result as ApplyChangesResult), replayed: true }
          }
        }

        const copy = await WorkingCopy.load(this.store, notebook)
        const { timezone, warning } = this.timezoneOf(copy)
        const now = zonedNow(this.clock.now(), timezone)
        const batch = new Batch({
          copy,
          actor,
          now,
          ...(req.confirm_new_names ? { confirmNewNames: req.confirm_new_names } : {}),
          staleLookup: (id) => this.findStale(notebook, copy, id),
        })
        for (const [i, op] of req.operations.entries()) {
          batch.begin(i, op.op)
          try {
            await runOperation(batch, op)
          } catch (e) {
            if (e instanceof NotebookError) e.operation = i
            throw e
          }
        }

        const descriptions = batch.descriptions()
        const summary =
          summarize(descriptions) || (batch.hasChanges() ? 'Added to the daily log' : 'No changes')
        const warnings: Warning[] = warning ? [warning] : []
        const changed = copy.changes()
        let changeId: string | null = null
        let files: FileSummary[] = changed.map(fileSummary)
        if (req.dry_run) {
          if (changed.length) {
            warnings.push({
              code: 'dry_run',
              message: 'Nothing was written. A real call also adds a line to the daily log.',
            })
          }
        } else if (changed.length) {
          changeId = newChangeId()
          files = await this.commit(notebook, copy, {
            changeId,
            summary,
            actor,
            now,
            logLine: descriptions.length > 0,
          })
        }
        const result: ApplyChangesResult = {
          change_id: changeId,
          dry_run: req.dry_run ?? false,
          replayed: false,
          summary,
          results: batch.results(),
          new_names: batch.newNames,
          files,
          warnings,
        }
        if (key && !req.dry_run) {
          await this.idempotency.put(notebook, key, { requestHash, result, at: Date.now() })
        }
        this.logger.info('apply_changes', {
          notebook,
          operations: req.operations.length,
          files: files.length,
          change_id: changeId ?? undefined,
          dry_run: req.dry_run ?? false,
          ms: Date.now() - started,
        })
        return result
      })
    } catch (e) {
      if (e instanceof NotebookError) {
        this.logger.info('apply_changes_refused', {
          notebook,
          code: e.code,
          operation: e.operation,
        })
      } else {
        this.logger.error('apply_changes_failed', { notebook, error: errorName(e) })
      }
      throw e
    }
  }

  /** Reverts one earlier change, as a new change, so history keeps both. */
  async undo(notebook: NotebookId, changeId: string, actorIn: Actor): Promise<UndoResult> {
    checkNotebookId(notebook)
    const actor = checkActor(actorIn)
    if (!CHANGE_ID.test(changeId)) {
      throw new NotebookError(
        'invalid_value',
        `"${changeId}" isn't a change id; change ids look like ch_7k2m9qxa.`,
      )
    }
    return this.lock.run(notebook, async () => {
      await this.requireNotebook(notebook)
      const record = await this.history.findChange(notebook, changeId)
      if (!record) {
        throw new NotebookError(
          'not_found',
          `There is no change ${changeId} in this notebook's history. Changes older than the retention window can't be undone.`,
        )
      }
      const copy = await WorkingCopy.load(this.store, notebook)
      const conflicts: string[] = []
      for (const f of record.files) {
        if (f.path.startsWith('log/')) continue
        if (f.path === 'my-rules.md' && !hasScope(actor, 'rules:write')) {
          throw new NotebookError(
            'forbidden',
            'This change touched my-rules.md, and undoing it needs the rules:write scope.',
          )
        }
        const current = copy.note(f.path)?.text.toString() ?? null
        let target: string | null
        if (current === f.after) target = f.before
        else if (current === null || f.after === null || f.before === null) {
          conflicts.push(f.path)
          continue
        } else {
          const merged = await this.history.merge(f.after, current, f.before)
          if (merged.conflict) {
            conflicts.push(f.path)
            continue
          }
          target = merged.text
        }
        if (target !== current) copy.replace(f.path, target)
      }
      if (conflicts.length) {
        throw new NotebookError(
          'conflict',
          `Change ${changeId} can't be undone cleanly: later changes touched the same lines in ${conflicts.join(', ')}. Make the reverse change with apply_changes instead.`,
          { files: conflicts },
        )
      }
      if (!copy.changes().length) {
        throw new NotebookError(
          'conflict',
          `Change ${changeId} has nothing left to undo; it may already have been undone.`,
        )
      }
      const now = zonedNow(this.clock.now(), this.timezoneOf(copy).timezone)
      const newId = newChangeId()
      const summary = `Undid ${changeId} (${record.summary})`
      const files = await this.commit(notebook, copy, { changeId: newId, summary, actor, now })
      this.logger.info('undo', {
        notebook,
        change_id: newId,
        undone: changeId,
        files: files.length,
      })
      return { change_id: newId, undone: changeId, summary, files }
    })
  }

  // ---------- internals ----------

  private async requireNotebook(notebook: NotebookId): Promise<void> {
    if (!(await this.store.exists(notebook))) {
      throw new NotebookError(
        'not_a_notebook',
        `There is no notebook "${notebook}". Start one with cos-notebook init.`,
      )
    }
  }

  private timezoneOf(copy: WorkingCopy): { timezone: string; warning?: Warning } {
    const tz = frontMatterValue(copy.note('my-rules.md')?.frontMatter ?? null, 'timezone')
    if (tz === undefined) return { timezone: this.defaultTimezone }
    if (isTimeZone(tz)) return { timezone: tz }
    return {
      timezone: this.defaultTimezone,
      warning: {
        code: 'timezone_invalid',
        message: `my-rules.md sets timezone to something that isn't a time zone, so ${this.defaultTimezone} was used. Fix it with rule and settings.timezone.`,
      },
    }
  }

  /** Adds the daily log line, writes every changed file, and records one history entry. */
  private async commit(
    notebook: NotebookId,
    copy: WorkingCopy,
    c: { changeId: string; summary: string; actor: Actor; now: ZonedNow; logLine?: boolean },
  ): Promise<FileSummary[]> {
    if (c.logLine !== false) addLogLine(copy, c)
    const changed = copy.changes()
    try {
      await this.store.write(
        notebook,
        changed.map((f) => ({ path: f.path, content: f.after })),
      )
      await this.history.commit(notebook, {
        changeId: c.changeId,
        summary: c.summary,
        author: actorAuthor(c.actor),
        paths: changed.map((f) => f.path),
      })
    } catch (e) {
      // All or nothing: put back what was there before.
      await this.store
        .write(
          notebook,
          changed.map((f) => ({ path: f.path, content: f.before })),
        )
        .catch((restoreError: unknown) =>
          this.logger.error('restore_failed', { notebook, error: errorName(restoreError) }),
        )
      throw e
    }
    return changed.map(fileSummary)
  }

  private async findStale(
    notebook: NotebookId,
    copy: WorkingCopy,
    id: string,
  ): Promise<StaleItem | null> {
    const versions = await this.history.recentVersions(notebook, STALE_SEARCH_CHANGES)
    for (const v of versions) {
      const was = parseNote(v.path, v.content).items.find((i) => i.id === id)
      if (!was) continue
      const now = bestSuccessor(copy, was)
      return { was: { file: was.path, text: was.text }, now }
    }
    return null
  }
}

function bestSuccessor(copy: WorkingCopy, was: Item): Candidate | null {
  const same = copy.items().find((i) => normalize(i.text) === normalize(was.text))
  if (same) return candidate(same)
  const inFile = (copy.note(was.path)?.items ?? [])
    .map((i) => ({ i, s: textSimilarity(was.text, i.text) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)[0]
  return inFile ? candidate(inFile.i) : null
}

function addLogLine(
  copy: WorkingCopy,
  c: { changeId: string; summary: string; actor: Actor; now: ZonedNow },
): void {
  const path = logPath(c.now.date)
  const fields = [
    { key: 'by', value: actorLabel(c.actor) },
    { key: 'change', value: c.changeId },
  ]
  let line: string
  try {
    line = renderChecked({ checked: null, text: `${c.now.time} ${c.summary}`, fields })
  } catch {
    line = renderChecked({
      checked: null,
      text: `${c.now.time} Changed ${copy.changes().length} notes`,
      fields,
    })
  }
  if (!copy.has(path)) copy.create(path, newNoteLines(path))
  const note = copy.note(path)!
  const lines = note.text.lines()
  let last = lines.length - 1
  while (last >= 0 && lines[last]!.trim() === '') last--
  const prevIsItem = note.items.some((i) => i.index <= last && last <= i.index + i.quoteCount)
  copy.splice(path, last + 1, 0, prevIsItem ? [line] : ['', line])
}

function summarize(descriptions: string[]): string {
  if (descriptions.length <= 3) return descriptions.join('; ')
  return `${descriptions.slice(0, 3).join('; ')}; and ${descriptions.length - 3} more`
}

function fileSummary(f: FileChange): FileSummary {
  return {
    path: f.path,
    status: f.before === null ? 'created' : f.after === null ? 'deleted' : 'changed',
  }
}

export function compactItem(item: Item): CompactItem {
  const fields: Record<string, string | string[]> = {}
  for (const f of item.fields) {
    const prev = fields[f.key]
    fields[f.key] =
      prev === undefined ? f.value : Array.isArray(prev) ? [...prev, f.value] : [prev, f.value]
  }
  return {
    id: item.id,
    file: item.path,
    text: item.text,
    done: item.checked,
    fields,
    links: item.links,
  }
}

function checkNotebookId(notebook: string): void {
  if (typeof notebook !== 'string' || !NOTEBOOK_ID.test(notebook)) {
    throw new NotebookError(
      'invalid_request',
      'A notebook id is 1 to 63 lowercase letters, digits, - or _.',
    )
  }
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function errorName(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code
  return e instanceof Error ? e.name : 'unknown'
}

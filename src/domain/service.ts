// The domain layer's front door. HTTP, MCP and the CLI call these methods and nothing else, so
// every change gets the same checks, provenance and history however it arrives.

import { createHash } from 'node:crypto'
import {
  frontMatterValue,
  parseFrontMatter,
  renderFrontMatterEntry,
} from '../format/front-matter.ts'
import { CHANGE_ID, newChangeId } from '../format/ids.ts'
import {
  starterFiles,
  type SpaceKind,
  logPath,
  newNoteLines,
  noteName,
  noteType,
  pathProblem,
} from '../format/layout.ts'
import { parseNote, type Item, type Note } from '../format/note.ts'
import {
  isTimeZone,
  parseSameAs,
  parseWorkspaceIds,
  WORK_NOTEBOOK,
  type SameAs,
  type WorkspaceId,
} from '../format/values.ts'
import { TextLines } from '../format/lines.ts'
import { actorAuthor, actorLabel, checkActor, hasScope, type Actor } from './actor.ts'
import {
  Batch,
  candidate,
  type Candidate,
  type OpResult,
  type StaleItem,
  type Warning,
} from './batch.ts'
import { cleanName, renderChecked } from './compose.ts'
import { NotebookError } from './errors.ts'
import { setFrontMatterLines } from './front-matter-edit.ts'
import { checkRef, formatRef, sameNotebook } from './notebook-ref.ts'
import { runOperation } from './operations.ts'
import {
  silentLogger,
  systemClock,
  type Clock,
  type History,
  type IdempotencyStore,
  type Lock,
  type Logger,
  type Author,
  type NotebookRef,
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

/** Settings that are the person's own preferences, before their my-rules.md changes them. */
export const DEFAULT_SETTINGS = {
  nudges_per_day: 3,
  stale_days: 30,
  meeting_prep: 'offer',
} as const

export interface ProfileLine extends CompactItem {
  /** The heading the line sits under, like "How I write" or "Where things go". */
  section: string
}

export interface ProfileWorkspace {
  /** The work notebook, like `workspace:northwind:alex`. */
  notebook: string
  timezone: string
  /** Ids clients use for this workspace (from `workspace_ids` in its my-rules.md). */
  workspace_ids: WorkspaceId[]
}

export interface Profile {
  /** The work notebook this conversation is in, when the client said; otherwise null. */
  current: string | null
  /** The time zone of the notebook being worked in: the current workspace's, else personal. */
  timezone: string
  /** The person's own preferences: defaults, changed by their personal my-rules.md. */
  settings: { nudges_per_day: number; stale_days: number; meeting_prep: string }
  /** about-me.md from the personal notebook. */
  about_me: ProfileLine[]
  /**
   * Rules: the personal notebook's first, then each work notebook's, each labelled with its
   * notebook. In a workspace, that workspace's rules win where they differ.
   */
  rules: ProfileLine[]
  /** Every work notebook in the profile. */
  workspaces: ProfileWorkspace[]
  warnings: Warning[]
}

export interface AdoptResult {
  change_id: string
  /** How many notes the folder had. */
  notes: number
  /** Starter files that were missing and were added. */
  added: string[]
  timezone: string
  /** Lines that don't fit the format, left as they are (the first 100). */
  problem_count: number
  problems: { path: string; line: number; message: string }[]
  /** Notes the format doesn't define, kept and read as free notes. */
  other_notes: string[]
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
  /** The notebook the item is in, like `workspace:northwind:alex`. Ids are unique only within it. */
  notebook: string
  file: string
  text: string
  done: boolean | null
  fields: Record<string, string | string[]>
  links: string[]
  /** The indented quote lines under the item, without their `>`. */
  quote: string[]
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
    notebook: NotebookRef,
    opts: { actor: Actor; timezone?: string },
  ): Promise<{ change_id: string; files: string[] }> {
    checkRef(notebook)
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
          'This folder already has notes in it, so nothing was changed. To make a notebook of the notes as they are, adopt the folder (cos-notebook adopt); otherwise choose an empty or new folder.',
        )
      }
      await this.store.create(notebook)
      await this.history.init(notebook)
      const copy = WorkingCopy.fromTexts(new Map())
      for (const path of starterFiles(notebook.space.kind)) {
        copy.create(path, starterLines(path, timezone, notebook.space.kind))
      }
      const now = zonedNow(this.clock.now(), timezone)
      const changeId = newChangeId()
      const files = await this.commit(notebook, copy, {
        changeId,
        summary: 'Started the notebook',
        by: byActor(actor),
        now,
      })
      this.logger.info('notebook_init', {
        notebook: formatRef(notebook),
        change_id: changeId,
        files: files.length,
      })
      return { change_id: changeId, files: files.map((f) => f.path) }
    })
  }

  /**
   * Makes a notebook of a folder that already has notes, such as one kept by the Chief of Staff
   * plugin, where it is. History starts with the notes exactly as they were (one change, nothing
   * rewritten); then the missing starter files and the time zone setting are added as a second
   * change. Lines that don't fit the format are reported, never changed. A folder that already has
   * history keeps it.
   */
  async adopt(
    notebook: NotebookRef,
    opts: { actor: Actor; timezone?: string },
  ): Promise<AdoptResult> {
    checkRef(notebook)
    const actor = checkActor(opts.actor)
    if (opts.timezone !== undefined && !isTimeZone(opts.timezone)) {
      throw new NotebookError(
        'invalid_value',
        `"${opts.timezone}" isn't a time zone; use an IANA name like Europe/Berlin.`,
      )
    }
    return this.lock.run(notebook, async () => {
      if (!(await this.store.exists(notebook)) || !(await this.store.list(notebook)).length) {
        throw new NotebookError(
          'not_found',
          'There are no notes here to adopt. Start a new notebook instead (cos-notebook init).',
        )
      }
      const state = await this.history.state(notebook)
      if (state.notebook) {
        throw new NotebookError(
          'conflict',
          'This folder is already a notebook; nothing was changed.',
        )
      }
      await this.history.init(notebook)
      const warnings: Warning[] = []
      if (state.insideAnotherRepository) {
        warnings.push({
          code: 'inside_another_repository',
          message:
            'The folder was inside another git repository. The notebook now has its own history in the folder; the outer repository should ignore it.',
        })
      }
      if (state.existingHistory) {
        warnings.push({
          code: 'existing_history',
          message:
            'The folder already had git history; it was kept, and the notebook continues it.',
        })
      }

      // 1. The notes exactly as they were.
      const asTheyWere = (await this.history.outsideChanges(notebook)).filter(
        (p) => !pathProblem(p),
      )
      let copy = await WorkingCopy.load(this.store, notebook)
      const set = frontMatterValue(copy.note('my-rules.md')?.frontMatter ?? null, 'timezone')
      const timezone =
        set !== undefined && isTimeZone(set) ? set : (opts.timezone ?? this.defaultTimezone)
      if (set !== undefined && !isTimeZone(set)) {
        warnings.push({
          code: 'timezone_invalid',
          message: `my-rules.md sets timezone to something that isn't a time zone, so it was left as it is and ${timezone} is used. Fix it with rule and settings.timezone.`,
        })
      }
      const now = zonedNow(this.clock.now(), timezone)
      if (asTheyWere.length) {
        await this.commit(notebook, copy, {
          changeId: newChangeId(),
          summary: `Notes as they were when the notebook was adopted (${asTheyWere.length})`,
          by: OUTSIDE,
          now,
          logLine: false,
          alsoRecord: asTheyWere,
        })
        copy = await WorkingCopy.load(this.store, notebook)
      }

      // 2. What the notebook needs to work: starter files, and the time zone.
      const added: string[] = []
      for (const path of starterFiles(notebook.space.kind)) {
        if (copy.has(path)) continue
        copy.create(path, starterLines(path, timezone, notebook.space.kind))
        added.push(path)
      }
      const rules = copy.note('my-rules.md')!
      if (set === undefined && !added.includes('my-rules.md')) {
        const edit = setFrontMatterLines(rules, 'timezone', timezone)
        copy.splice('my-rules.md', edit.start, edit.count, edit.lines)
      }
      const notes = copy.paths().length - added.length
      const problems = copy.paths().flatMap((p) => copy.note(p)!.problems)
      const other = copy.paths().filter((p) => copy.note(p)!.type === 'other')
      const parts = [`${notes} notes`]
      if (added.length) parts.push(`added ${added.join(', ')}`)
      if (set === undefined) parts.push(`timezone ${timezone}`)
      const changeId = newChangeId()
      await this.commit(notebook, copy, {
        changeId,
        summary: `Adopted the notebook (${parts.join('; ')})`,
        by: byActor(actor),
        now,
      })
      this.logger.info('notebook_adopted', {
        notebook: formatRef(notebook),
        change_id: changeId,
        notes,
        added: added.length,
        problems: problems.length,
      })
      return {
        change_id: changeId,
        notes,
        added,
        timezone,
        problem_count: problems.length,
        problems: problems
          .slice(0, 100)
          .map(({ path, line, message }) => ({ path, line, message })),
        other_notes: other,
        warnings,
      }
    })
  }

  // ---------- reads ----------

  async readNote(notebook: NotebookRef, path: string) {
    checkRef(notebook)
    const problem = pathProblem(path)
    if (problem) throw new NotebookError('invalid_value', `The path "${path}" ${problem}.`)
    await this.requireNotebook(notebook)
    const text = await this.store.read(notebook, path)
    if (text === null) throw new NotebookError('not_found', `There is no note ${path}.`)
    const note = parseNote(path, text)
    const sameAs = frontMatterValue(note.frontMatter, 'same_as')
    return {
      path,
      type: note.type,
      front_matter: Object.fromEntries(
        (note.frontMatter?.entries ?? []).map((e) => [e.key, e.value]),
      ),
      /** The same person's notes in work notebooks (person notes in a personal notebook). */
      same_as: sameAs !== undefined ? parseSameAs(sameAs).links : [],
      items: note.items.map((i) => compactItem(i, notebook)),
      problems: note.problems.map(({ line, message }) => ({ line, message })),
      text,
    }
  }

  /**
   * The profile an agent loads to work for the person: the defaults, then the personal
   * notebook's about-me.md and my-rules.md, then the my-rules.md of each of the person's work
   * notebooks. `current` says which workspace the conversation is in, as a notebook or as an id
   * the client uses for it (`{ source: 'slack', id: 'T024BE7LD' }`); it decides the time zone.
   * A read across the person's notebooks; nothing combined is stored.
   */
  async profile(
    personal: NotebookRef,
    opts: { work?: readonly NotebookRef[]; current?: NotebookRef | WorkspaceId } = {},
  ): Promise<Profile> {
    checkRef(personal)
    if (personal.space.kind !== 'personal') {
      throw new NotebookError(
        'invalid_value',
        'A profile starts from a personal notebook; pass one first.',
      )
    }
    const work = [...(opts.work ?? [])]
    const current = opts.current
    if (
      current !== undefined &&
      'space' in current &&
      !work.some((w) => sameNotebook(w, current))
    ) {
      work.push(current)
    }
    for (const w of work) {
      checkRef(w)
      if (w.space.kind !== 'workspace') {
        throw new NotebookError('invalid_value', `${formatRef(w)} isn't a work notebook.`)
      }
    }
    await this.requireNotebook(personal)
    const read = async (nb: NotebookRef, path: string) => {
      await this.requireNotebook(nb)
      const text = await this.store.read(nb, path)
      return text === null ? null : parseNote(path, text)
    }
    const aboutMe = await read(personal, 'about-me.md')
    const personalRules = await read(personal, 'my-rules.md')
    const workRules = await Promise.all(work.map((w) => read(w, 'my-rules.md')))

    const fm = personalRules?.frontMatter ?? null
    const count = (key: string, fallback: number) => {
      const v = frontMatterValue(fm, key)
      return v !== undefined && /^\d+$/.test(v) ? Number(v) : fallback
    }
    const prep = frontMatterValue(fm, 'meeting_prep')
    const zone = (note: Note | null) => {
      const tz = frontMatterValue(note?.frontMatter ?? null, 'timezone')
      return tz !== undefined && isTimeZone(tz) ? tz : undefined
    }
    const lines = (note: Note | null, nb: NotebookRef): ProfileLine[] =>
      (note?.items ?? []).map((i) => ({ ...compactItem(i, nb), section: i.section.at(-1) ?? '' }))
    const personalZone = zone(personalRules) ?? this.defaultTimezone
    const workspaces: ProfileWorkspace[] = work.map((w, i) => {
      const ids = frontMatterValue(workRules[i]?.frontMatter ?? null, 'workspace_ids')
      return {
        notebook: formatRef(w),
        timezone: zone(workRules[i] ?? null) ?? personalZone,
        workspace_ids: ids !== undefined ? parseWorkspaceIds(ids).ids : [],
      }
    })

    const warnings: Warning[] = []
    let chosen: ProfileWorkspace | null = null
    if (current !== undefined && 'space' in current) {
      chosen = workspaces.find((w) => w.notebook === formatRef(current)) ?? null
    } else if (current !== undefined) {
      const matches = workspaces.filter((w) =>
        w.workspace_ids.some((x) => x.source === current.source && x.id === current.id),
      )
      if (matches.length > 1) {
        throw new NotebookError(
          'ambiguous',
          `The ${current.source} id ${current.id} is recorded for more than one work notebook: ${matches.map((m) => m.notebook).join(', ')}. Remove it from all but one.`,
          { candidates: matches.map((m) => m.notebook) },
        )
      }
      chosen = matches[0] ?? null
      if (!chosen) {
        warnings.push({
          code: 'unknown_workspace',
          message: `No work notebook has the ${current.source} id ${current.id}. Ask the person which workspace this is, then record it there with the identify operation.`,
          source: current.source,
          id: current.id,
        })
      }
    }
    return {
      current: chosen?.notebook ?? null,
      timezone: chosen?.timezone ?? personalZone,
      settings: {
        nudges_per_day: count('nudges_per_day', DEFAULT_SETTINGS.nudges_per_day),
        stale_days: count('stale_days', DEFAULT_SETTINGS.stale_days),
        meeting_prep:
          prep !== undefined && ['offer', 'auto', 'off'].includes(prep)
            ? prep
            : DEFAULT_SETTINGS.meeting_prep,
      },
      about_me: lines(aboutMe, personal),
      rules: [
        ...lines(personalRules, personal),
        ...work.flatMap((w, i) => lines(workRules[i] ?? null, w)),
      ],
      workspaces,
      warnings,
    }
  }

  /**
   * The person notes in a personal notebook that link to a note in one work notebook: how an
   * agent reading a work note finds the person's own note on the same person. Reads only the
   * personal notebook's people notes. The work notebook is named as `same_as` stores it
   * (`workspace:northwind:alex`), and each result carries only the links to that notebook, so a
   * lookup from one workspace never reveals the person's other spaces.
   */
  async findLinkedPeople(
    personal: NotebookRef,
    target: { notebook: string; name?: string },
  ): Promise<{ path: string; name: string; links: SameAs[] }[]> {
    checkRef(personal)
    if (personal.space.kind !== 'personal') {
      throw new NotebookError(
        'invalid_value',
        'Links between people are kept in a personal notebook; pass one.',
      )
    }
    const notebook = typeof target.notebook === 'string' ? target.notebook.trim() : ''
    if (!WORK_NOTEBOOK.test(notebook)) {
      throw new NotebookError(
        'invalid_value',
        `"${notebook}" isn't a work notebook name; they look like workspace:northwind:alex.`,
      )
    }
    const name = target.name !== undefined ? cleanName(target.name) : undefined
    await this.requireNotebook(personal)
    const people = (await this.store.list(personal)).filter((p) => noteType(p) === 'person')
    const out: { path: string; name: string; links: SameAs[] }[] = []
    for (const path of people) {
      const text = await this.store.read(personal, path)
      if (text === null) continue
      const value = frontMatterValue(
        parseFrontMatter(TextLines.parse(text).lines()).frontMatter,
        'same_as',
      )
      if (value === undefined) continue
      const links = parseSameAs(value).links.filter(
        (l) => l.notebook === notebook && (name === undefined || l.name === name),
      )
      if (links.length) out.push({ path, name: noteName(path)!, links })
    }
    return out
  }

  /**
   * Items from one or more notebooks as one view, each labelled with its notebook. The caller
   * passes the notebooks the client may read (all of them by default; narrowed on request).
   * Reading never writes, and nothing combined is stored.
   */
  async listItems(
    notebooks: NotebookRef | readonly NotebookRef[],
    opts: { file?: string } = {},
  ): Promise<CompactItem[]> {
    const list = Array.isArray(notebooks) ? notebooks : [notebooks as NotebookRef]
    if (!list.length)
      throw new NotebookError('invalid_request', 'Name at least one notebook to read.')
    const out: CompactItem[] = []
    const seen = new Set<string>()
    for (const notebook of list) {
      checkRef(notebook)
      const key = formatRef(notebook)
      if (seen.has(key)) continue
      seen.add(key)
      await this.requireNotebook(notebook)
      const copy = await WorkingCopy.load(this.store, notebook)
      for (const item of copy.items()) {
        if (opts.file === undefined || item.path === opts.file)
          out.push(compactItem(item, notebook))
      }
    }
    return out
  }

  /** The notebook's time zone and today's date in it. */
  async today(notebook: NotebookRef): Promise<ZonedNow> {
    checkRef(notebook)
    await this.requireNotebook(notebook)
    const copy = await WorkingCopy.load(this.store, notebook)
    return zonedNow(this.clock.now(), this.timezoneOf(copy).timezone)
  }

  // ---------- writes ----------

  async applyChanges(
    notebook: NotebookRef,
    input: unknown,
    actorIn: Actor,
  ): Promise<ApplyChangesResult> {
    const started = Date.now()
    checkRef(notebook)
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
            this.logger.info('apply_changes_replayed', { notebook: formatRef(notebook) })
            return { ...(prior.result as ApplyChangesResult), replayed: true }
          }
        }

        const outside = req.dry_run ? null : await this.recordOutsideEdits(notebook)
        const copy = await WorkingCopy.load(this.store, notebook)
        const { timezone, warning } = this.timezoneOf(copy)
        const now = zonedNow(this.clock.now(), timezone)
        const batch = new Batch({
          notebook,
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
        if (outside) {
          warnings.push({
            code: 'outside_edits',
            message: `${outside.files.length} note${outside.files.length > 1 ? 's were' : ' was'} changed outside the service since the last change; that was recorded first, as ${outside.change_id}.`,
            change_id: outside.change_id,
            files: outside.files,
          })
        }
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
            by: byActor(actor),
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
          notebook: formatRef(notebook),
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
          notebook: formatRef(notebook),
          code: e.code,
          operation: e.operation,
        })
      } else {
        this.logger.error('apply_changes_failed', {
          notebook: formatRef(notebook),
          error: errorName(e),
        })
      }
      throw e
    }
  }

  /** Reverts one earlier change, as a new change, so history keeps both. */
  async undo(notebook: NotebookRef, changeId: string, actorIn: Actor): Promise<UndoResult> {
    checkRef(notebook)
    const actor = checkActor(actorIn)
    if (!CHANGE_ID.test(changeId)) {
      throw new NotebookError(
        'invalid_value',
        `"${changeId}" isn't a change id; change ids look like ch_7k2m9qxa.`,
      )
    }
    return this.lock.run(notebook, async () => {
      await this.requireNotebook(notebook)
      await this.recordOutsideEdits(notebook)
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
      const files = await this.commit(notebook, copy, {
        changeId: newId,
        summary,
        by: byActor(actor),
        now,
      })
      this.logger.info('undo', {
        notebook: formatRef(notebook),
        change_id: newId,
        undone: changeId,
        files: files.length,
      })
      return { change_id: newId, undone: changeId, summary, files }
    })
  }

  // ---------- internals ----------

  private async requireNotebook(notebook: NotebookRef): Promise<void> {
    if (!(await this.store.exists(notebook))) {
      throw new NotebookError(
        'not_a_notebook',
        `There is no notebook ${formatRef(notebook)}. Start one with cos-notebook init.`,
      )
    }
  }

  /**
   * Records notes changed outside the service (by hand, in Obsidian, by another tool) as their
   * own change, so the next change holds only what its caller did, and history and the daily log
   * show everything. Runs under the notebook lock, before each write. The edits are recorded
   * exactly as they are, even lines that don't fit the format.
   */
  private async recordOutsideEdits(
    notebook: NotebookRef,
  ): Promise<{ change_id: string; files: string[] } | null> {
    const files = (await this.history.outsideChanges(notebook)).filter((p) => !pathProblem(p))
    if (!files.length) return null
    const copy = await WorkingCopy.load(this.store, notebook)
    const now = zonedNow(this.clock.now(), this.timezoneOf(copy).timezone)
    const shown = files.slice(0, 5).join(', ')
    const more = files.length > 5 ? ` and ${files.length - 5} more` : ''
    const changeId = newChangeId()
    await this.commit(notebook, copy, {
      changeId,
      summary: `Edited outside the service: ${shown}${more}`,
      by: OUTSIDE,
      now,
      alsoRecord: files,
    })
    this.logger.info('outside_edits', {
      notebook: formatRef(notebook),
      change_id: changeId,
      files: files.length,
    })
    return { change_id: changeId, files }
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
    notebook: NotebookRef,
    copy: WorkingCopy,
    c: {
      changeId: string
      summary: string
      by: By
      now: ZonedNow
      logLine?: boolean
      /** Files already on disk to record with this change (edits made outside the service). */
      alsoRecord?: readonly string[]
    },
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
        author: c.by.author,
        paths: [...new Set([...(c.alsoRecord ?? []), ...changed.map((f) => f.path)])],
      })
    } catch (e) {
      // All or nothing: put back what was there before.
      await this.store
        .write(
          notebook,
          changed.map((f) => ({ path: f.path, content: f.before })),
        )
        .catch((restoreError: unknown) =>
          this.logger.error('restore_failed', {
            notebook: formatRef(notebook),
            error: errorName(restoreError),
          }),
        )
      throw e
    }
    return changed.map(fileSummary)
  }

  private async findStale(
    notebook: NotebookRef,
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

/** Who a change is recorded as: the label in the daily log, and the author in history. */
interface By {
  label: string
  author: Author
}

function byActor(actor: Actor): By {
  return { label: actorLabel(actor), author: actorAuthor(actor) }
}

/** Edits found on disk that no call made: by hand, in Obsidian, or by another tool. */
const OUTSIDE: By = {
  label: 'outside the service',
  author: { name: 'outside the service', email: 'outside@cos-notebook.invalid' },
}

function addLogLine(
  copy: WorkingCopy,
  c: { changeId: string; summary: string; by: By; now: ZonedNow },
): void {
  const path = logPath(c.now.date)
  const fields = [
    { key: 'by', value: c.by.label },
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

export function compactItem(item: Item, notebook: NotebookRef): CompactItem {
  const fields: Record<string, string | string[]> = {}
  for (const f of item.fields) {
    const prev = fields[f.key]
    fields[f.key] =
      prev === undefined ? f.value : Array.isArray(prev) ? [...prev, f.value] : [prev, f.value]
  }
  return {
    id: item.id,
    notebook: formatRef(notebook),
    file: item.path,
    text: item.text,
    done: item.checked,
    fields,
    links: item.links,
    quote: item.quote,
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

/**
 * The lines a starter file begins with. A personal my-rules.md gets the default settings; a
 * work notebook's gets only its time zone, since the other settings are the person's own.
 */
function starterLines(path: string, timezone: string, space: SpaceKind): string[] {
  const lines = newNoteLines(path, space)
  if (path !== 'my-rules.md') return lines
  const settings: [string, string][] =
    space === 'workspace'
      ? [['timezone', timezone]]
      : [
          ['timezone', timezone],
          ['nudges_per_day', String(DEFAULT_SETTINGS.nudges_per_day)],
          ['stale_days', String(DEFAULT_SETTINGS.stale_days)],
          ['meeting_prep', DEFAULT_SETTINGS.meeting_prep],
        ]
  return ['---', ...settings.map(([k, v]) => renderFrontMatterEntry(k, v)), '---', ...lines]
}

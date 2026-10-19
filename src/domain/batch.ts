// The state of one apply_changes call while its operations run: the workspace, who is acting,
// today's date, names seen, and what each operation changed.

import { setFrontMatterLines } from './front-matter-edit.ts'
import { frontMatterValue } from '../format/front-matter.ts'
import {
  ARCHIVE_PATH,
  LOG_PATH,
  isDraftHistoryPath,
  newNoteLines,
  PERSONAL_ONLY_FILES,
  noteName,
  noteType,
  pathProblem,
} from '../format/layout.ts'
import type { Item, Note } from '../format/note.ts'
import { actorLabel, hasScope, type Actor } from './actor.ts'
import { cleanName } from './compose.ts'
import { NotebookError } from './errors.ts'
import { checkName, type KnownName, type NameType } from './names.ts'
import { nameProblem } from '../format/values.ts'
import type { NotebookRef } from './notebook-ref.ts'
import type { Target } from './request.ts'
import { phraseMatches, textSimilarity } from './similarity.ts'
import type { ZonedNow } from './time.ts'
import type { WorkingCopy } from './working-copy.ts'

export interface ResultItem {
  id: string | null
  file: string
  line: string
  previous_id?: string
}

export interface LineChange {
  file: string
  before: string[]
  after: string[]
}

export interface Warning {
  code: string
  message: string
  [key: string]: unknown
}

export interface OpResult {
  index: number
  op: string
  status: string
  items: ResultItem[]
  changes: LineChange[]
  warnings: Warning[]
}

export interface Candidate {
  id: string
  file: string
  text: string
}

export interface StaleItem {
  was: { file: string; text: string }
  now: Candidate | null
}

export type StaleLookup = (id: string) => Promise<StaleItem | null>

interface PendingItem {
  path: string
  raw: string
  occurrence: number
  previousId?: string
}

interface OpRecord {
  index: number
  op: string
  status: string
  items: PendingItem[]
  changes: LineChange[]
  warnings: Warning[]
  descriptions: string[]
}

const DEFAULT_SCOPE_EXCLUDES = (path: string) =>
  LOG_PATH.test(path) || ARCHIVE_PATH.test(path) || path === 'brief.md' || path.startsWith('log/')

export class Batch {
  readonly copy: WorkingCopy
  readonly actor: Actor
  readonly now: ZonedNow
  readonly newNames: string[] = []
  private readonly confirmed: Set<string>
  private readonly staleLookup: StaleLookup
  private readonly records: OpRecord[] = []
  private current: OpRecord | null = null
  private known: KnownName[] | null = null
  /** Ids changed earlier in this call, so later operations can still use the id they read. */
  private readonly aliases = new Map<string, { path: string; raw: string }>()
  /** The one notebook this call writes. */
  readonly notebook: NotebookRef

  constructor(opts: {
    notebook: NotebookRef
    copy: WorkingCopy
    actor: Actor
    now: ZonedNow
    confirmNewNames?: readonly string[]
    staleLookup: StaleLookup
  }) {
    this.notebook = opts.notebook
    this.copy = opts.copy
    this.actor = opts.actor
    this.now = opts.now
    this.confirmed = new Set(opts.confirmNewNames ?? [])
    this.staleLookup = opts.staleLookup
  }

  get today(): string {
    return this.now.date
  }

  get defaultSource(): string {
    return this.actor.source ?? 'agent'
  }

  begin(index: number, op: string): void {
    this.current = {
      index,
      op,
      status: 'unchanged',
      items: [],
      changes: [],
      warnings: [],
      descriptions: [],
    }
    this.records.push(this.current)
  }

  private get rec(): OpRecord {
    if (!this.current) throw new Error('No operation is running')
    return this.current
  }

  status(s: string): void {
    this.rec.status = s
  }

  describe(s: string): void {
    this.rec.descriptions.push(s)
  }

  warn(code: string, message: string, extra: Record<string, unknown> = {}): void {
    this.rec.warnings.push({ code, message, ...extra })
  }

  descriptions(): string[] {
    return this.records.flatMap((r) => r.descriptions)
  }

  hasChanges(): boolean {
    return this.records.some((r) => r.changes.length > 0)
  }

  // ---------- writing ----------

  /** Refuses writes the actor may not make, and notes the service keeps to itself. */
  checkWritable(
    path: string,
    opts: { allowLog?: boolean; allowArchive?: boolean; withoutRulesScope?: boolean } = {},
  ): void {
    const problem = pathProblem(path)
    if (problem) throw new NotebookError('invalid_value', `The path "${path}" ${problem}.`)
    if (this.notebook.space.kind === 'workspace' && PERSONAL_ONLY_FILES.includes(path)) {
      throw new NotebookError(
        'invalid_value',
        `${path} describes the person and travels with them, so it lives only in their personal notebook. Write it there.`,
      )
    }
    if (path === 'my-rules.md' && !opts.withoutRulesScope && !hasScope(this.actor, 'rules:write')) {
      throw new NotebookError(
        'forbidden',
        'Changing my-rules.md needs the rules:write scope. Ask the person to make this change, or to grant that scope.',
      )
    }
    if (LOG_PATH.test(path) && !opts.allowLog) {
      throw new NotebookError(
        'invalid_value',
        'The daily log is written with the log operation, not edited directly.',
      )
    }
    if (ARCHIVE_PATH.test(path) && !opts.allowArchive) {
      throw new NotebookError(
        'invalid_value',
        'Items reach the archive through the archive operation.',
      )
    }
  }

  private record(path: string, before: string[], after: string[]): void {
    const last = this.rec.changes.at(-1)
    if (last && last.file === path) {
      last.before.push(...before)
      last.after.push(...after)
    } else {
      this.rec.changes.push({ file: path, before: [...before], after: [...after] })
    }
  }

  /** The note at `path`, created from its template if it doesn't exist yet. */
  ensureNote(path: string, lines?: readonly string[]): Note {
    const existing = this.copy.note(path)
    if (existing) return existing
    const initial = lines ?? newNoteLines(path, this.notebook.space.kind)
    this.record(path, [], [...initial])
    return this.copy.create(path, initial)
  }

  /** Replaces a whole note (brief.md starting a new day), or creates it. */
  replaceNote(path: string, lines: readonly string[]): void {
    const existing = this.copy.note(path)
    if (!existing) {
      this.ensureNote(path, lines)
      return
    }
    const removed = this.copy.splice(path, 0, existing.text.length, lines)
    this.record(path, removed, [...lines])
  }

  /** Records a section replaced by direct edits (brief and draft sections). */
  replacedSection(path: string, before: readonly string[], after: readonly string[]): void {
    this.record(path, [...before], [...after])
  }

  /** Writes a file that isn't a note: a draft's earlier version in drafts/.history/. */
  writeHistoryFile(path: string, text: string): void {
    if (!isDraftHistoryPath(path)) throw new Error(`${path} isn't a draft history path`)
    this.copy.writeFile(path, text)
    this.record(path, [], [`(earlier version kept as ${path})`])
  }

  insert(path: string, index: number, lines: readonly string[]): void {
    this.copy.splice(path, index, 0, lines)
    this.record(path, [], [...lines])
  }

  /** Replaces an item (its line and quote lines) with new lines. */
  replaceItem(item: Item, lines: readonly string[]): void {
    const removed = this.copy.splice(item.path, item.index, 1 + item.quoteCount, lines)
    this.record(item.path, removed, [...lines])
    if (lines[0] !== undefined && lines[0] !== item.raw) {
      const to = { path: item.path, raw: lines[0] }
      this.aliases.set(item.id, to)
      for (const [id, a] of this.aliases)
        if (a.path === item.path && a.raw === item.raw) this.aliases.set(id, to)
    }
  }

  removeItem(item: Item): string[] {
    const removed = this.copy.splice(item.path, item.index, 1 + item.quoteCount, [])
    this.record(item.path, removed, [])
    return removed
  }

  /**
   * Adds lines at the end of a section (a heading's title, matched case-insensitively), or at the
   * end of the note when no section is given. A missing section is added at the end.
   */
  appendToSection(path: string, section: string | undefined, lines: readonly string[]): void {
    const note = this.ensureNote(path)
    const all = note.text.lines()
    const bodyStart = note.frontMatter ? note.frontMatter.end + 1 : 0
    let start = bodyStart
    let end = all.length
    let headingIndex = -1
    if (section) {
      const want = section
        .replace(/^#+\s*/, '')
        .trim()
        .toLowerCase()
      const heading =
        note.headings.find((h) => h.title.toLowerCase() === want && h.level === 2) ??
        note.headings.find((h) => h.title.toLowerCase() === want)
      if (!heading) {
        const tail = all.length && all[all.length - 1]!.trim() !== '' ? [''] : []
        this.insert(path, all.length, [
          ...tail,
          `## ${section.replace(/^#+\s*/, '').trim()}`,
          ...lines,
        ])
        return
      }
      headingIndex = heading.index
      start = heading.index + 1
      const next = note.headings.find((h) => h.index > heading.index && h.level <= heading.level)
      end = next ? next.index : all.length
    }
    // New items go after the section's last item; in a section with no items, after its last line.
    const lastItem = note.items.filter((i) => i.index >= start && i.index < end).at(-1)
    let last = lastItem ? lastItem.index + lastItem.quoteCount : end - 1
    while (!lastItem && last >= start && all[last]!.trim() === '') last--
    if (last < start) last = headingIndex >= 0 ? headingIndex : bodyStart - 1
    const prev = last >= 0 ? all[last]! : null
    const prevIsList =
      prev !== null &&
      (note.items.some((i) => i.index <= last && last <= i.index + i.quoteCount) ||
        (/^#{2,6}\s/.test(prev) && last === headingIndex))
    const needsBlank = prev !== null && !prevIsList
    this.insert(path, last + 1, needsBlank ? ['', ...lines] : lines)
  }

  setFrontMatter(path: string, key: string, value: string | null): boolean {
    const note = this.ensureNote(path)
    if (frontMatterValue(note.frontMatter, key) === (value ?? undefined)) return false
    const edit = setFrontMatterLines(note, key, value)
    const removed = this.copy.splice(path, edit.start, edit.count, edit.lines)
    this.record(path, removed, edit.lines)
    return true
  }

  // ---------- results ----------

  /** Notes an item this operation wrote; its final id is worked out when the call ends. */
  resultItem(path: string, raw: string, previousId?: string): void {
    const note = this.copy.note(path)
    const lines = note ? note.text.lines() : []
    const at = note?.items.findLast((i) => i.raw === raw)
    let occurrence = 0
    if (at) for (let i = 0; i < at.index; i++) if (lines[i] === raw) occurrence++
    this.rec.items.push({ path, raw, occurrence, ...(previousId ? { previousId } : {}) })
  }

  results(): OpResult[] {
    return this.records.map((r) => ({
      index: r.index,
      op: r.op,
      status: r.status,
      items: r.items.map((p) => this.finalItem(p)),
      changes: r.changes,
      warnings: r.warnings,
    }))
  }

  private finalItem(p: PendingItem): ResultItem {
    const note = this.copy.note(p.path)
    const same = note?.items.filter((i) => i.raw === p.raw) ?? []
    const item = same[Math.min(p.occurrence, same.length - 1)]
    return {
      id: item?.id ?? null,
      file: p.path,
      line: p.raw,
      ...(p.previousId ? { previous_id: p.previousId } : {}),
    }
  }

  // ---------- names ----------

  private knownNames(): KnownName[] {
    if (!this.known) {
      const out: KnownName[] = []
      for (const path of this.copy.paths()) {
        const t = noteType(path)
        const name = noteName(path)
        if (name && (t === 'person' || t === 'project' || t === 'area')) out.push({ name, type: t })
      }
      for (const item of this.copy.items())
        for (const l of item.links) out.push({ name: l, type: 'link' })
      this.known = out
    }
    return this.known
  }

  /**
   * Checks a person, project or area name: an existing name comes back in its existing spelling;
   * a close but different one is refused with the closest matches; a new one is accepted.
   */
  resolveName(raw: string, type: Exclude<NameType, 'link'>, label = type): string {
    const name = cleanName(raw)
    const problem = nameProblem(name)
    if (problem) throw new NotebookError('invalid_value', `The ${label} name "${raw}" ${problem}.`)
    const check = checkName(name, this.knownNames())
    if (check.status === 'existing') return check.name
    if (check.status === 'close' && !this.confirmed.has(name)) {
      const list = check.matches
        .map((m) => `${m.name} (${m.type === 'link' ? 'linked' : m.type})`)
        .join(', ')
      throw new NotebookError(
        'close_name',
        `"${name}" is close to ${check.matches.length > 1 ? 'existing names' : 'an existing name'}: ${list}. Use the existing name, or if "${name}" is someone or something new, repeat the call with "confirm_new_names": ["${name}"].`,
        { name, matches: check.matches },
      )
    }
    if (!this.newNames.includes(name)) {
      this.newNames.push(name)
      this.knownNames().push({ name, type })
      this.warn('new_name', `"${name}" is a new ${type} name.`, { name, type })
    }
    return name
  }

  // ---------- addressing items ----------

  async resolve(
    target: Target,
    opts: { reject?: (item: Item) => string | null; scope?: (path: string) => boolean } = {},
  ): Promise<Item> {
    if (target.file !== undefined) {
      const problem = pathProblem(target.file)
      if (problem) throw new NotebookError('invalid_value', `The file "${target.file}" ${problem}.`)
      if (!this.copy.has(target.file))
        throw new NotebookError('not_found', `There is no note ${target.file}.`)
    }
    if (target.id) return this.resolveId(target.id, target.file, opts.reject)
    if (target.match) return this.resolveMatch(target.match, target.file, opts)
    throw new NotebookError(
      'invalid_request',
      'Name the item with "id" (from a read) or "match" (a phrase from it).',
    )
  }

  private async resolveId(
    id: string,
    file: string | undefined,
    reject?: (item: Item) => string | null,
  ): Promise<Item> {
    let item = this.copy.findById(id)
    if (!item) {
      const alias = this.aliases.get(id)
      if (alias) item = this.copy.note(alias.path)?.items.find((i) => i.raw === alias.raw)
    }
    if (item && file !== undefined && item.path !== file) {
      throw new NotebookError('not_found', `Item ${id} is in ${item.path}, not ${file}.`, {
        item: candidate(item),
      })
    }
    if (!item) {
      const stale = await this.staleLookup(id)
      if (stale) {
        const now = stale.now
          ? ` Now it reads: ${stale.now.id} "${stale.now.text}" in ${stale.now.file}. Retry with that id if it's the same item.`
          : ' It is no longer in the notebook.'
        throw new NotebookError(
          'stale_id',
          `Item ${id} has changed since it was read. It was: "${stale.was.text}" in ${stale.was.file}.${now}`,
          { id, was: stale.was, now: stale.now },
        )
      }
      throw new NotebookError(
        'not_found',
        `No item has id ${id}. Ids change when a line changes; read the item again, or name it with "match".`,
        { id },
      )
    }
    const why = reject?.(item)
    if (why)
      throw new NotebookError('invalid_value', `Item ${item.id} ${why}.`, { item: candidate(item) })
    return item
  }

  private resolveMatch(
    phrase: string,
    file: string | undefined,
    opts: { reject?: (item: Item) => string | null; scope?: (path: string) => boolean },
  ): Item {
    const inScope = (i: Item) =>
      file !== undefined
        ? i.path === file
        : opts.scope
          ? opts.scope(i.path)
          : !DEFAULT_SCOPE_EXCLUDES(i.path)
    const pool = this.copy.items().filter((i) => inScope(i) && !opts.reject?.(i))
    const scored = pool.map((i) => ({ i, m: phraseMatches(phrase, i.text) })).filter((x) => x.m)
    // The best kind of match wins: the whole text, then the phrase as a run of words, then the
    // words in any order.
    const tier = (['exact', 'contains', 'words'] as const).find((t) =>
      scored.some((x) => x.m === t),
    )
    const best = scored.filter((x) => x.m === tier)
    const hits = best.length === 1 ? best : scored
    const where = file ? ` in ${file}` : ''
    if (hits.length === 1) return hits[0]!.i
    if (hits.length === 0) {
      const closest = pool
        .map((i) => ({ i, s: textSimilarity(phrase, i.text) }))
        .filter((x) => x.s > 0.2)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => candidate(x.i))
      const hint = closest.length
        ? ` Closest: ${closest.map((c) => `${c.id} "${c.text}"${file ? '' : ` in ${c.file}`}`).join('; ')}.`
        : ''
      throw new NotebookError(
        'not_found',
        `No item matches "${phrase}"${where}.${hint} Retry with an id, or a phrase from the item.`,
        {
          candidates: closest,
        },
      )
    }
    const candidates = hits.slice(0, 10).map((x) => candidate(x.i))
    throw new NotebookError(
      'ambiguous',
      `"${phrase}" matches ${hits.length} items${where}: ${candidates.map((c) => `${c.id} "${c.text}"${file ? '' : ` in ${c.file}`}`).join('; ')}. Retry with the id of the one you mean.`,
      { candidates },
    )
  }

  label(): string {
    return actorLabel(this.actor)
  }
}

export function candidate(item: Item): Candidate {
  return { id: item.id, file: item.path, text: item.text }
}

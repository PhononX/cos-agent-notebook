// Reads across the notebooks a client may read, as one view. Every result names its notebook.
// Reads never write and nothing combined is stored. Every list takes `limit` and returns a
// `next_cursor` when there is more.

import { z } from 'zod'
import { ITEM_KINDS, KIND_LAYOUT, kindOfFile, noteName, type ItemKind } from '../format/layout.ts'
import type { Item } from '../format/note.ts'
import { DATE } from '../format/values.ts'
import { NotebookError } from './errors.ts'
import { checkName, type KnownName } from './names.ts'
import { formatRef, type NotebookRef } from './notebook-ref.ts'
import { normalize, textSimilarity, tokens } from './similarity.ts'
import { daysBetween, type ZonedNow } from './time.ts'
import type { WorkingCopy } from './working-copy.ts'

export interface LoadedNotebook {
  ref: NotebookRef
  name: string
  copy: WorkingCopy
  now: ZonedNow
}

const limit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('How many to return (default 50)')
const cursor = z.string().optional().describe('next_cursor from the previous page')
const notebooksFilter = z
  .array(z.string())
  .max(20)
  .optional()
  .describe(
    'Only these notebooks, like ["personal:alex:default"]; all the client may read if left out',
  )
const kindsFilter = z.array(z.enum(ITEM_KINDS as [ItemKind, ...ItemKind[]])).optional()
const date = z.string().describe('YYYY-MM-DD')

export const GetItemsInput = z.strictObject({
  notebooks: notebooksFilter,
  kinds: kindsFilter,
  file: z.string().optional().describe('Only items in this note, like projects/Q4 Launch.md'),
  person: z.string().optional(),
  project: z.string().optional(),
  area: z.string().optional(),
  status: z.enum(['open', 'done', 'all']).optional().describe('open (default), done or all'),
  due_before: date.optional(),
  due_after: date.optional(),
  untouched_days: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Only items whose newest date (src, since, nudged…) is at least this many days old'),
  limit,
  cursor,
})
export type GetItemsInput = z.infer<typeof GetItemsInput>

export const SearchInput = z.strictObject({
  query: z.string().min(1),
  notebooks: notebooksFilter,
  kinds: kindsFilter,
  file: z.string().optional(),
  person: z.string().optional(),
  project: z.string().optional(),
  limit,
  cursor,
})

export const ResolveNamesInput = z.strictObject({
  names: z.array(z.string()).min(1).max(20),
  notebooks: notebooksFilter,
})

export const ReviewInput = z.strictObject({
  notebooks: notebooksFilter,
  kinds: z
    .array(z.enum(['overdue', 'stale', 'never_nudged', 'duplicate', 'recurring']))
    .optional()
    .describe('Which kinds of candidate; all if left out'),
  limit,
})

export const GetChangesInput = z.strictObject({
  notebooks: notebooksFilter,
  since: z.string().optional().describe('An ISO 8601 time, or a change id: only changes after it'),
  limit,
  cursor,
})

export const ReadNoteInput = z.strictObject({
  notebook: z.string().describe('The notebook, like personal:alex:default'),
  path: z.string().describe('The note, like people/Dana Whitfield.md'),
  sections: z.array(z.string()).max(20).optional().describe('Only these sections (## headings)'),
})

export const StartSessionInput = z.strictObject({
  workspace: z
    .union([z.string(), z.strictObject({ source: z.string(), id: z.string() })])
    .optional()
    .describe(
      'The workspace this conversation is in: its notebook (workspace:northwind:alex), or your own id for it ({ "source": "slack", "id": "T024BE7LD" })',
    ),
  notebooks: notebooksFilter,
})

/** The short version of docs/spaces.md that start_session gives every agent. */
export const FILING_RULES = [
  "Whose business is it? The company's goes in that workspace's notebook; the person's own goes in their personal notebook.",
  "A workspace keeps: confidential business, customers and partners, work product, work commitments, colleagues in their work role, other people's HR matters, work projects and areas.",
  'The person keeps: themselves (preferences, life, how they write), their career and own employment (job search, own pay and reviews), relationships as people, general know-how, personal plans.',
  "When it isn't clear which, ask the person; the channel it came through is only a hint. Split mixed items, and never copy work content into the personal notebook.",
  'The personal notebook has a note for everyone the person deals with; a colleague can be just a name and a same_as link to their work note.',
]

// ---------- paging ----------

export function page<T>(
  all: readonly T[],
  opts: { limit?: number | undefined; cursor?: string | undefined },
) {
  const size = opts.limit ?? 50
  let offset = 0
  if (opts.cursor !== undefined) {
    const m = /^o(\d{1,9})$/.exec(Buffer.from(opts.cursor, 'base64url').toString('utf8'))
    if (!m)
      throw new NotebookError(
        'invalid_request',
        'cursor is not one this service returned; start again without it.',
      )
    offset = Number(m[1])
  }
  const items = all.slice(offset, offset + size)
  const next =
    offset + size < all.length ? Buffer.from(`o${offset + size}`).toString('base64url') : null
  return { items, next_cursor: next, total: all.length }
}

// ---------- items ----------

/** The kind of an item, from its note. Lines without a checkbox in actions.md and waiting.md
 * (the "Elsewhere" pointers) aren't actions or waiting items. */
export function itemKind(item: Item): ItemKind | null {
  const kind = kindOfFile(item.path)
  if (kind !== null && KIND_LAYOUT[kind].checkbox && item.checked === null) return null
  return kind
}

/** The newest date written on the line: its src, since, nudged, done, or a date it starts with. */
export function newestDate(item: Item): string | null {
  const dates: string[] = []
  for (const f of item.fields) {
    const d = f.value.slice(0, 10)
    if (DATE.test(d)) dates.push(d)
    for (const part of f.value.split(' ')) if (DATE.test(part)) dates.push(part)
  }
  const lead = /^(\d{4}-\d{2}-\d{2})\s/.exec(item.text)
  if (lead) dates.push(lead[1]!)
  return dates.length ? dates.sort().at(-1)! : null
}

export function isOpen(item: Item): boolean {
  if (item.checked !== null) return item.checked === false
  if (item.path === 'decisions.md') return !item.fields.some((f) => f.key === 'superseded')
  return true
}

function mentions(item: Item, name: string): boolean {
  const n = normalize(name)
  return item.links.some((l) => normalize(l) === n) || normalize(noteName(item.path) ?? '') === n
}

function inScope(
  item: Item,
  input: { kinds?: ItemKind[] | undefined; file?: string | undefined },
  named: string[],
) {
  if (input.file !== undefined) return item.path === input.file
  const kind = itemKind(item)
  if (input.kinds?.length) return kind !== null && input.kinds.includes(kind)
  if (kind !== null) return true
  // Items in a person's, project's or area's own note count when asked about them.
  const own = noteName(item.path)
  return own !== null && named.some((n) => normalize(n) === normalize(own))
}

export function selectItems(
  nbs: readonly LoadedNotebook[],
  input: GetItemsInput,
): { nb: LoadedNotebook; item: Item }[] {
  const named = [input.person, input.project, input.area].filter(
    (x): x is string => x !== undefined,
  )
  const status = input.status ?? 'open'
  const out: { nb: LoadedNotebook; item: Item }[] = []
  for (const nb of nbs) {
    for (const item of nb.copy.items()) {
      if (!inScope(item, input, named)) continue
      if (status === 'open' && !isOpen(item)) continue
      if (status === 'done' && isOpen(item)) continue
      if (input.person !== undefined && !mentions(item, input.person)) continue
      if (input.project !== undefined && !mentions(item, input.project)) continue
      if (input.area !== undefined && !mentions(item, input.area)) continue
      const due = item.fields.find((f) => f.key === 'due')?.value
      if (input.due_before !== undefined && !(due !== undefined && due < input.due_before)) continue
      if (input.due_after !== undefined && !(due !== undefined && due > input.due_after)) continue
      if (input.untouched_days !== undefined) {
        const newest = newestDate(item)
        if (newest === null || daysBetween(newest, nb.now.date) < input.untouched_days) continue
      }
      out.push({ nb, item })
    }
  }
  return out
}

// ---------- search ----------

export function searchItems(
  nbs: readonly LoadedNotebook[],
  input: z.infer<typeof SearchInput>,
): { nb: LoadedNotebook; item: Item; score: number }[] {
  const words = tokens(input.query)
  if (!words.length) throw new NotebookError('invalid_value', 'query has no words to search for.')
  const phrase = normalize(input.query)
  const hits: { nb: LoadedNotebook; item: Item; score: number }[] = []
  const candidates = selectItems(nbs, {
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.person !== undefined ? { person: input.person } : {}),
    ...(input.project !== undefined ? { project: input.project } : {}),
    status: 'all',
  })
  // Without a kind or file, search every note, the archive and the log included.
  const pool =
    input.kinds ||
    input.file !== undefined ||
    input.person !== undefined ||
    input.project !== undefined
      ? candidates
      : nbs.flatMap((nb) => nb.copy.items().map((item) => ({ nb, item })))
  for (const { nb, item } of pool) {
    const haystack = normalize(
      [
        item.text,
        ...item.quote,
        ...item.fields.map((f) => f.value),
        noteName(item.path) ?? '',
      ].join(' '),
    )
    const have = new Set(haystack.split(' '))
    if (!words.every((w) => have.has(w))) continue
    let score = 1
    if (` ${haystack} `.includes(` ${phrase} `)) score += 2
    if (isOpen(item)) score += 0.5
    if (item.path.startsWith('archive/') || item.path.startsWith('log/')) score -= 0.5
    hits.push({ nb, item, score })
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score || (newestDate(b.item) ?? '').localeCompare(newestDate(a.item) ?? ''),
  )
}

// ---------- names ----------

export function knownNamesOf(copy: WorkingCopy): KnownName[] {
  const out: KnownName[] = []
  for (const path of copy.paths()) {
    const note = copy.note(path)!
    const name = noteName(path)
    if (name && (note.type === 'person' || note.type === 'project' || note.type === 'area')) {
      out.push({ name, type: note.type })
    }
  }
  for (const item of copy.items()) for (const l of item.links) out.push({ name: l, type: 'link' })
  return out
}

export function resolveNamesIn(nbs: readonly LoadedNotebook[], names: readonly string[]) {
  return names.map((name) => ({
    name,
    notebooks: nbs.map((nb) => {
      const check = checkName(name.trim(), knownNamesOf(nb.copy))
      return {
        notebook: nb.name,
        status: check.status,
        ...(check.status === 'existing' ? { existing: check.name, type: check.type } : {}),
        ...(check.status === 'close' ? { matches: check.matches } : {}),
      }
    }),
  }))
}

// ---------- review candidates ----------

export type ReviewKind = 'overdue' | 'stale' | 'never_nudged' | 'duplicate' | 'recurring'

export interface ReviewCandidate {
  kind: ReviewKind
  reason: string
  nb: LoadedNotebook
  items: Item[]
}

const STALE_KINDS: readonly ItemKind[] = ['action', 'waiting', 'idea', 'inbox']

export function reviewCandidates(
  nbs: readonly LoadedNotebook[],
  opts: { kinds?: readonly ReviewKind[] | undefined; staleDays: number },
): ReviewCandidate[] {
  const want = (k: ReviewKind) => !opts.kinds?.length || opts.kinds.includes(k)
  const out: ReviewCandidate[] = []
  for (const nb of nbs) {
    const open = nb.copy.items().filter((i) => itemKind(i) !== null && isOpen(i))
    for (const item of open) {
      const kind = itemKind(item)!
      const due = item.fields.find((f) => f.key === 'due')?.value
      if (
        want('overdue') &&
        kind === 'action' &&
        due !== undefined &&
        DATE.test(due) &&
        due < nb.now.date
      ) {
        out.push({ kind: 'overdue', reason: `due ${due}`, nb, items: [item] })
      }
      if (want('stale') && STALE_KINDS.includes(kind)) {
        const newest = newestDate(item)
        if (newest !== null && daysBetween(newest, nb.now.date) >= opts.staleDays) {
          out.push({ kind: 'stale', reason: `nothing on it since ${newest}`, nb, items: [item] })
        }
      }
      if (
        want('never_nudged') &&
        kind === 'waiting' &&
        !item.fields.some((f) => f.key === 'nudged')
      ) {
        const since = item.fields.find((f) => f.key === 'since')?.value
        out.push({
          kind: 'never_nudged',
          reason: since ? `waiting since ${since}, never nudged` : 'never nudged',
          nb,
          items: [item],
        })
      }
    }
    if (want('duplicate')) {
      const byFile = new Map<string, Item[]>()
      for (const i of open) byFile.set(i.path, [...(byFile.get(i.path) ?? []), i])
      for (const list of byFile.values()) {
        for (let a = 0; a < list.length; a++) {
          for (let c = a + 1; c < list.length; c++) {
            if (textSimilarity(list[a]!.text, list[c]!.text) >= 0.8) {
              out.push({
                kind: 'duplicate',
                reason: 'these read alike; merge them if they are the same',
                nb,
                items: [list[a]!, list[c]!],
              })
            }
          }
        }
      }
    }
    if (want('recurring')) {
      const ideas = open.filter((i) => itemKind(i) === 'idea')
      const inbox = open.filter((i) => itemKind(i) === 'inbox')
      for (const idea of ideas) {
        const sources = idea.fields.filter((f) => f.key === 'src').length
        const echoes = [...ideas, ...inbox].filter(
          (o) => o !== idea && textSimilarity(o.text, idea.text) >= 0.6,
        )
        if (sources >= 2 || echoes.length) {
          out.push({
            kind: 'recurring',
            reason: `came up ${Math.max(sources, 1) + echoes.length} times; worth a project, or bringing back?`,
            nb,
            items: [idea, ...echoes],
          })
        }
      }
    }
  }
  return out
}

/** Which notebooks of those the client may read a call covers. */
export function narrow(
  available: readonly NotebookRef[],
  filter: readonly string[] | undefined,
): NotebookRef[] {
  if (!filter?.length) return [...available]
  return filter.map((name) => {
    const found = available.find((r) => formatRef(r) === name.trim())
    if (!found) {
      throw new NotebookError(
        'forbidden',
        `${name} isn't one of the notebooks this client can read: ${available.map(formatRef).join(', ')}.`,
      )
    }
    return found
  })
}

export const KIND_FILES = Object.fromEntries(ITEM_KINDS.map((k) => [k, KIND_LAYOUT[k].file]))

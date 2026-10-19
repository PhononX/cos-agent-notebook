// The write tools beside apply_changes: write_brief, update_catch_up, save_draft and
// clear_nudges. Each runs through the same batch as apply_changes (one notebook, all or nothing,
// one history entry, one daily log line), as an operation kind of its own.

import { z } from 'zod'
import { frontMatterValue, renderFrontMatterEntry } from '../format/front-matter.ts'
import { setField, type Field } from '../format/item.ts'
import { draftHistoryPath, namedNotePath } from '../format/layout.ts'
import type { Item } from '../format/note.ts'
import { nameProblem, TIME } from '../format/values.ts'
import type { Batch } from './batch.ts'
import {
  buildSrc,
  checkDate,
  checkFieldValue,
  checkNoSecret,
  checkQuote,
  checkSentence,
  checkText,
  cleanName,
  linkNames,
  renderChecked,
  shortText,
} from './compose.ts'
import { NotebookError } from './errors.ts'
import {
  archiveItem,
  frontMatterValues,
  linkTargets,
  notInArchiveOrLog,
  quoteLines,
  rawQuoteLines,
  rerender,
  runOperation,
} from './operations.ts'
import { date, links, names, parseInput, quote, target, text, type Operation } from './request.ts'
import { normalize } from './similarity.ts'

const common = {
  idempotency_key: z.string().min(8).max(200).optional(),
  dry_run: z.boolean().optional(),
}

const fieldValues = z.record(z.string(), z.union([z.string(), z.number()]))

const BriefLine = z.union([
  z.string(),
  z.strictObject({
    text,
    ...links,
    src: z.string().optional(),
    fields: fieldValues.optional(),
    quote: quote.optional(),
  }),
])

export const WriteBriefInput = z.strictObject({
  name: z.string().describe('The brief\'s name, like "Morning brief"'),
  sent: z.string().optional().describe('HH:MM it was sent; now if left out'),
  sections: z
    .array(z.strictObject({ title: z.string(), lines: z.array(BriefLine).min(1).max(50) }))
    .max(20)
    .optional(),
  follow_ups: z
    .array(
      z.strictObject({
        text,
        ...links,
        src: z.string().optional(),
        draft: quote.optional().describe("The message to send, in the person's voice"),
      }),
    )
    .max(20)
    .optional(),
  ...common,
})

export const UpdateCatchUpInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        link: z.string().describe("The thread's address: the email, chat or message link"),
        source: z.string().describe('Where the thread is: gmail, slack, cv…'),
        text,
        kind: z.enum(['reply', 'missed', 'changed']),
        person: names.optional(),
        project: z.string().optional(),
        since: date.optional(),
      }),
    )
    .max(50)
    .optional(),
  close: z
    .array(z.strictObject({ link: z.string().optional(), ...target, why: z.string() }))
    .max(50)
    .optional(),
  ...common,
})

export const SaveDraftInput = z.strictObject({
  name: z.string(),
  draft: z.string().describe('The whole new version of the draft, in Markdown'),
  change: z.string().describe('What changed in this version, in a few words'),
  kind: z.string().optional(),
  status: z.string().optional(),
  horizon: z.enum(['soon', 'long']).optional(),
  for: z.string().optional().describe('The person it is for'),
  project: z.string().optional(),
  due: date.optional(),
  src: z.string().optional(),
  notes: z
    .array(
      z.union([
        z.string(),
        z.strictObject({ text, ...links, src: z.string().optional(), quote: quote.optional() }),
      ]),
    )
    .max(50)
    .optional(),
  ...common,
})

export const ClearNudgesInput = z.strictObject({
  ids: z.array(z.string()).max(50).optional(),
  match: z.string().optional(),
  all: z.boolean().optional(),
  ...common,
})

export type ToolSchema =
  | typeof WriteBriefInput
  | typeof UpdateCatchUpInput
  | typeof SaveDraftInput
  | typeof ClearNudgesInput

type Strip<T> = Omit<T, 'idempotency_key' | 'dry_run'>

export type ToolOperation =
  | ({ op: 'write_brief' } & Strip<z.infer<typeof WriteBriefInput>>)
  | ({ op: 'update_catch_up' } & Strip<z.infer<typeof UpdateCatchUpInput>>)
  | ({ op: 'save_draft' } & Strip<z.infer<typeof SaveDraftInput>>)
  | ({ op: 'clear_nudges' } & Strip<z.infer<typeof ClearNudgesInput>>)

export type AnyOperation = Operation | ToolOperation

export function parseToolInput(schema: ToolSchema, input: unknown, _tool: string) {
  return parseInput(schema as z.ZodType, input) as {
    idempotency_key?: string
    dry_run?: boolean
  } & Record<string, unknown>
}

export async function runAnyOperation(b: Batch, op: AnyOperation): Promise<void> {
  switch (op.op) {
    case 'write_brief':
      return writeBrief(b, op)
    case 'update_catch_up':
      return updateCatchUp(b, op)
    case 'save_draft':
      return saveDraft(b, op)
    case 'clear_nudges':
      return clearNudges(b, op)
    default:
      return runOperation(b, op)
  }
}

type OpOf<K extends ToolOperation['op']> = Extract<ToolOperation, { op: K }>

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function checkTitle(value: string, label: string): string {
  const t = checkText(value, label, 120)
  if (/[[\]#]/.test(t)) throw new NotebookError('invalid_value', `${label} can't contain [ ] or #.`)
  return t
}

function extraFields(values: Record<string, string | number> | undefined): Field[] {
  let fields: Field[] = []
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) {
      throw new NotebookError(
        'invalid_value',
        `"${k}" isn't a field name: use lowercase letters, digits and _.`,
      )
    }
    if (k === 'src') throw new NotebookError('invalid_value', 'Pass src as its own value.')
    fields = setField(fields, k, checkFieldValue(String(v), k))
  }
  return fields
}

// ---------- write_brief ----------

async function writeBrief(b: Batch, op: OpOf<'write_brief'>): Promise<void> {
  const path = 'brief.md'
  b.checkWritable(path)
  const name = checkTitle(op.name, 'name')
  const sent = op.sent ?? b.now.time
  if (!TIME.test(sent)) throw new NotebookError('invalid_value', 'sent must be a time, HH:MM.')
  if (!op.sections?.length && !op.follow_ups?.length) {
    throw new NotebookError('invalid_value', 'A brief needs at least one section or follow-up.')
  }

  const lines: string[] = [`## ${name} [sent:: ${sent}]`]
  for (const section of op.sections ?? []) {
    const title = checkTitle(section.title, 'section title')
    if (title.toLowerCase() === 'follow-ups') {
      throw new NotebookError(
        'invalid_value',
        'Pass follow-ups as follow_ups, so they are numbered.',
      )
    }
    lines.push('', `### ${title}`)
    for (const entry of section.lines) {
      const e = typeof entry === 'string' ? { text: entry } : entry
      const sentence = linkNames(checkSentence(e.text, 'brief line'), linkTargets(b, e))
      const fields = extraFields('fields' in e ? e.fields : undefined)
      if ('src' in e && e.src !== undefined) {
        fields.push({ key: 'src', value: buildSrc(e.src, b.defaultSource, b.today) })
      }
      lines.push(renderChecked({ checked: null, text: sentence, fields }, 'brief line'))
      lines.push(...quoteLines(checkQuote('quote' in e ? e.quote : undefined)))
    }
  }
  if (op.follow_ups?.length) {
    lines.push('', '### Follow-ups')
    op.follow_ups.forEach((f, i) => {
      const sentence = linkNames(checkSentence(f.text, 'follow-up'), linkTargets(b, f))
      const fields: Field[] =
        f.src !== undefined
          ? [{ key: 'src', value: buildSrc(f.src, b.defaultSource, b.today) }]
          : []
      lines.push(
        renderChecked({ marker: `${i + 1}.`, checked: null, text: sentence, fields }, 'follow-up'),
      )
      lines.push(...quoteLines(checkQuote(f.draft, 'draft'), '   '))
    })
  }

  // The first brief of the day starts the file again; the old one stays in history.
  const current = b.copy.note(path)
  const today = b.today
  if (!current || frontMatterValue(current.frontMatter, 'date') !== today) {
    const [, m, d] = today.split('-').map(Number) as [number, number, number]
    const heading = `# Briefs for ${b.now.weekday}, ${MONTHS[m - 1]} ${d}`
    b.replaceNote(path, [
      '---',
      renderFrontMatterEntry('date', today),
      '---',
      heading,
      '',
      ...lines,
    ])
  } else {
    // Writing a brief again under the same name replaces it; otherwise it goes at the end.
    const note = b.copy.note(path)!
    const same = note.headings.find(
      (h) => h.level === 2 && h.title.toLowerCase() === name.toLowerCase(),
    )
    if (same) {
      const next = note.headings.find((h) => h.index > same.index && h.level <= 2)
      let end = next ? next.index : note.text.length
      while (end > same.index + 1 && note.text.line(end - 1).trim() === '') end--
      b.copy.splice(path, same.index, end - same.index, lines)
      b.replacedSection(path, note.text.lines().slice(same.index, end), lines)
    } else {
      const all = note.text.lines()
      const tail = all.length && all[all.length - 1]!.trim() !== '' ? [''] : []
      b.insert(path, all.length, [...tail, ...lines])
    }
  }
  const items = b.copy.note(path)!.items
  for (const l of lines) if (items.some((i) => i.raw === l)) b.resultItem(path, l)
  b.status('updated')
  b.describe(`Wrote the ${name} in brief.md`)
}

// ---------- update_catch_up ----------

const CATCH_UP_SECTIONS = {
  reply: 'Needs your reply',
  missed: 'You may have missed',
  changed: 'Changed',
}

function srcLink(item: Item): string | null {
  const src = item.fields.find((f) => f.key === 'src')?.value ?? ''
  const link = src.split(' ').find((p) => /^https?:\/\//.test(p))
  return link ?? null
}

async function updateCatchUp(b: Batch, op: OpOf<'update_catch_up'>): Promise<void> {
  const path = 'catch-up.md'
  b.checkWritable(path)
  if (!op.items?.length && !op.close?.length) {
    throw new NotebookError(
      'invalid_value',
      'update_catch_up needs "items" to add or raise, or "close".',
    )
  }
  b.ensureNote(path)
  const parts: string[] = []
  for (const it of op.items ?? []) {
    const link = it.link.trim()
    if (!/^https?:\/\/\S+$/.test(link)) {
      throw new NotebookError(
        'invalid_value',
        "link must be the thread's full http or https address.",
      )
    }
    const sentence = linkNames(checkSentence(it.text, 'text'), linkTargets(b, it))
    const existing = b.copy.note(path)!.items.find((i) => srcLink(i) === link)
    if (existing) {
      // Mentioned again: raise the count, and take the newer wording and kind.
      const raised = Number(existing.fields.find((f) => f.key === 'raised')?.value ?? '0') + 1
      let fields = setField(existing.fields, 'raised', String(Number.isFinite(raised) ? raised : 1))
      fields = setField(fields, 'kind', it.kind)
      const line = rerender(existing, { text: sentence, fields, top: true })
      const section = existing.section.at(-1)
      if (section && section.toLowerCase() !== CATCH_UP_SECTIONS[it.kind].toLowerCase()) {
        const quotes = rawQuoteLines(b, existing)
        b.removeItem(existing)
        b.appendToSection(path, CATCH_UP_SECTIONS[it.kind], [line, ...quotes])
      } else {
        b.replaceItem(existing, [line, ...rawQuoteLines(b, existing)])
      }
      b.resultItem(path, line, existing.id)
      parts.push(`raised "${shortText(sentence, 40)}"`)
    } else {
      const fields: Field[] = [
        { key: 'kind', value: it.kind },
        { key: 'since', value: it.since !== undefined ? checkDate(it.since, 'since') : b.today },
        { key: 'raised', value: '1' },
        {
          key: 'src',
          value: buildSrc(`${it.source} ${b.today} ${link}`, b.defaultSource, b.today),
        },
      ]
      const line = renderChecked({ checked: null, text: sentence, fields })
      b.appendToSection(path, CATCH_UP_SECTIONS[it.kind], [line])
      b.resultItem(path, line)
      parts.push(`added "${shortText(sentence, 40)}"`)
    }
  }
  for (const c of op.close ?? []) {
    const why = checkFieldValue(c.why, 'why')
    let item: Item | undefined
    if (c.link !== undefined) {
      item = b.copy.note(path)!.items.find((i) => srcLink(i) === c.link!.trim())
      if (!item) {
        throw new NotebookError(
          'not_found',
          `No catch-up line has the thread link ${c.link}. Name it by id or match instead.`,
        )
      }
    } else {
      item = await b.resolve({ ...c, file: path }, { reject: notInArchiveOrLog })
    }
    const archived = archiveItem(b, item, why)
    b.resultItem(`archive/${b.today.slice(0, 7)}.md`, archived, item.id)
    parts.push(`closed "${shortText(item.text, 40)}" (${why})`)
  }
  b.status('updated')
  b.describe(`Catch-up: ${parts.join(', ')}`)
}

// ---------- save_draft ----------

const DRAFT_MAX = 200_000

async function saveDraft(b: Batch, op: OpOf<'save_draft'>): Promise<void> {
  const name = cleanName(op.name)
  const problem = nameProblem(name)
  if (problem) throw new NotebookError('invalid_value', `The draft name "${op.name}" ${problem}.`)
  const path = namedNotePath('draft', name)
  b.checkWritable(path)

  if (op.draft.length > DRAFT_MAX)
    throw new NotebookError('invalid_value', 'The draft is too long to save.')
  checkNoSecret(op.draft, 'draft')
  const body = op.draft.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n')
  if (body.some((l) => /^#{1,2}\s/.test(l))) {
    throw new NotebookError(
      'invalid_value',
      "A draft can't contain # or ## headings, which would break the note into sections. Use ### for headings inside it.",
    )
  }
  const change = checkFieldValue(op.change, 'change')
  const src = buildSrc(op.src, b.defaultSource, b.today)

  const front: Record<string, string | null> = {}
  if (op.kind !== undefined) front.kind = op.kind
  if (op.status !== undefined) front.status = op.status
  if (op.horizon !== undefined) front.horizon = op.horizon
  if (op.for !== undefined) front.for = `[[${b.resolveName(op.for, 'person')}]]`
  if (op.project !== undefined) front.project = `[[${b.resolveName(op.project, 'project')}]]`
  if (op.due !== undefined) front.due = checkDate(op.due, 'due')

  const notes: string[] = []
  for (const n of op.notes ?? []) {
    const e = typeof n === 'string' ? { text: n } : n
    const sentence = linkNames(checkSentence(e.text, 'note'), linkTargets(b, e))
    const fields = [
      { key: 'src', value: buildSrc('src' in e ? e.src : undefined, b.defaultSource, b.today) },
    ]
    notes.push(renderChecked({ checked: null, text: sentence, fields }, 'note'))
    notes.push(...quoteLines(checkQuote('quote' in e ? e.quote : undefined)))
  }

  const existing = b.copy.note(path)
  let version = 1
  if (!existing) {
    const entries = frontMatterValues(b, 'draft', {
      ...front,
      status: front.status ?? 'draft',
      version: '1',
      touched: b.today,
    }).filter((e): e is [string, string] => e[1] !== null)
    const history = renderChecked({
      checked: null,
      text: `v1 ${b.today} ${change}`,
      fields: [{ key: 'src', value: src }],
    })
    b.ensureNote(path, [
      '---',
      ...entries.map(([k, v]) => renderFrontMatterEntry(k, v)),
      '---',
      `# ${name}`,
      '',
      '## Draft',
      ...body,
      '',
      '## Notes',
      ...notes,
      '',
      '## History',
      history,
    ])
    b.resultItem(path, history)
    b.status('created')
  } else {
    const current = Number(frontMatterValue(existing.frontMatter, 'version') ?? '1')
    const previous = Number.isInteger(current) && current > 0 ? current : 1
    version = previous + 1
    // Keep the version before this one, whole, in drafts/.history/.
    b.writeHistoryFile(draftHistoryPath(name, previous), existing.text.toString())

    const values = frontMatterValues(b, 'draft', {
      ...front,
      version: String(version),
      touched: b.today,
    })
    for (const [k, v] of values) b.setFrontMatter(path, k, v)

    const note = b.copy.note(path)!
    const draftHeading = note.headings.find(
      (h) => h.level === 2 && h.title.toLowerCase() === 'draft',
    )
    if (draftHeading) {
      const next = note.headings.find((h) => h.index > draftHeading.index && h.level <= 2)
      let end = next ? next.index : note.text.length
      while (end > draftHeading.index + 1 && note.text.line(end - 1).trim() === '') end--
      const before = note.text.lines().slice(draftHeading.index + 1, end)
      b.copy.splice(path, draftHeading.index + 1, end - draftHeading.index - 1, body)
      b.replacedSection(path, before, body)
    } else {
      b.appendToSection(path, 'Draft', body)
    }
    if (notes.length) b.appendToSection(path, 'Notes', notes)
    const history = renderChecked({
      checked: null,
      text: `v${version} ${b.today} ${change}`,
      fields: [{ key: 'src', value: src }],
    })
    // History is newest first: the new line goes right under the heading.
    const after = b.copy.note(path)!
    const historyHeading = after.headings.find(
      (h) => h.level === 2 && h.title.toLowerCase() === 'history',
    )
    if (historyHeading) b.insert(path, historyHeading.index + 1, [history])
    else b.appendToSection(path, 'History', [history])
    b.resultItem(path, history)
    b.status('updated')
  }
  b.describe(`Saved v${version} of the draft "${name}" (${change})`)
}

// ---------- clear_nudges ----------

async function clearNudges(b: Batch, op: OpOf<'clear_nudges'>): Promise<void> {
  const path = 'nudges.md'
  b.checkWritable(path)
  if (!op.all && !op.ids?.length && op.match === undefined) {
    throw new NotebookError('invalid_value', 'clear_nudges needs "ids", "match", or "all": true.')
  }
  const note = b.copy.note(path)
  if (!note) return
  let targets: Item[]
  if (op.all) {
    targets = [...note.items]
  } else {
    targets = []
    for (const id of op.ids ?? []) targets.push(await b.resolve({ id, file: path }))
    if (op.match !== undefined) targets.push(await b.resolve({ match: op.match, file: path }))
  }
  const seen = new Set<string>()
  const unique = targets.filter((t) => !seen.has(t.id) && seen.add(t.id))
  // Remove from the bottom up, so earlier lines keep their place.
  for (const t of unique.sort((x, y) => y.index - x.index)) {
    const current = b.copy
      .note(path)!
      .items.find((i) => i.raw === t.raw && normalize(i.text) === normalize(t.text))
    if (current) b.removeItem(current)
  }
  if (unique.length) {
    b.status('updated')
    b.describe(`Cleared ${unique.length} nudge${unique.length > 1 ? 's' : ''}`)
  }
}

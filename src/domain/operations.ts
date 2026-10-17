// The apply_changes operation kinds. Each one reads structured fields, checks them, and edits
// the workspace through the batch, which records what changed.

import { type Field, removeField, setField } from '../format/item.ts'
import {
  ARCHIVE_PATH,
  CATCH_UP_SECTIONS,
  KIND_LAYOUT,
  LOG_PATH,
  archivePath,
  kindOfFile,
  logPath,
  namedNotePath,
  newNoteLines,
  PERSONAL_ONLY_SECTIONS,
  PERSONAL_ONLY_SETTINGS,
  noteType,
  pathProblem,
  type NamedNoteType,
} from '../format/layout.ts'
import type { Item } from '../format/note.ts'
import { frontMatterValue, renderFrontMatterEntry } from '../format/front-matter.ts'
import {
  DATE,
  KEY,
  fieldValueProblem,
  frontMatterProblem,
  nameProblem,
  parseSameAs,
  renderSameAs,
  SAME_AS_MAX_LINKS,
  WORK_NOTEBOOK,
  WORKSPACE_ID_SOURCE,
  WORKSPACE_ID_VALUE,
  parseWorkspaceIds,
  renderWorkspaceIds,
} from '../format/values.ts'
import { type Batch } from './batch.ts'
import {
  buildSrc,
  checkDate,
  checkNoSecret,
  cleanName,
  checkFieldValue,
  checkQuote,
  checkSentence,
  checkText,
  linkNames,
  renderChecked,
  shortText,
  type LinkTarget,
} from './compose.ts'
import { NotebookError } from './errors.ts'
import type { Entry, Operation, OperationOf } from './request.ts'
import { normalize, textSimilarity } from './similarity.ts'

export async function runOperation(b: Batch, op: Operation): Promise<void> {
  switch (op.op) {
    case 'add':
      return add(b, op)
    case 'complete':
      return complete(b, op)
    case 'update':
      return update(b, op)
    case 'archive':
      return archive(b, op)
    case 'move':
      return move(b, op)
    case 'decide':
      return decide(b, op)
    case 'note':
      return note(b, op)
    case 'merge':
      return merge(b, op)
    case 'promote':
      return promote(b, op)
    case 'set_focus':
      return setFocus(b, op)
    case 'rule':
      return rule(b, op)
    case 'log':
      return log(b, op)
    case 'identify':
      return identify(b, op)
  }
}

// ---------- shared pieces ----------

interface Links {
  person?: string | string[] | undefined
  project?: string | undefined
  area?: string | undefined
}

function linkTargets(b: Batch, o: Links): LinkTarget[] {
  const out: LinkTarget[] = []
  const people = o.person === undefined ? [] : Array.isArray(o.person) ? o.person : [o.person]
  for (const p of people) out.push({ name: b.resolveName(p, 'person'), type: 'person' })
  if (o.project !== undefined)
    out.push({ name: b.resolveName(o.project, 'project'), type: 'project' })
  if (o.area !== undefined) out.push({ name: b.resolveName(o.area, 'area'), type: 'area' })
  return out
}

const RESERVED_FIELDS: Record<string, string> = {
  src: 'src records where an item came from; pass it as "src", and it is never changed afterwards',
  done: 'use the complete operation, or "done" on update',
  archived: 'use the archive operation',
  from: 'use the archive operation',
  superseded: 'use decide with "supersedes"',
  by: 'the service sets it',
  change: 'the service sets it',
}

function checkExtraField(key: string, value: string | number): Field {
  if (!KEY.test(key)) {
    throw new NotebookError(
      'invalid_value',
      `"${key}" isn't a field name: use lowercase letters, digits and _.`,
    )
  }
  const reserved = RESERVED_FIELDS[key]
  if (reserved)
    throw new NotebookError('invalid_value', `The ${key} field can't be set here: ${reserved}.`)
  const v = checkFieldValue(String(value), key)
  const problem = fieldValueProblem(key, v)
  if (problem) throw new NotebookError('invalid_value', `${problem}.`)
  return { key, value: v }
}

function quoteLines(quote: string[], indent = '  '): string[] {
  return quote.map((q) => (q ? `${indent}> ${q}` : `${indent}>`))
}

function rawQuoteLines(b: Batch, item: Item): string[] {
  return b.copy
    .note(item.path)!
    .text.lines()
    .slice(item.index + 1, item.index + 1 + item.quoteCount)
}

/** An item line in its existing form, with some parts changed. */
function rerender(
  item: Item,
  change: { checked?: boolean | null; text?: string; fields?: Field[]; top?: boolean },
  label = 'item',
): string {
  return renderChecked(
    {
      indent: change.top ? '' : item.indent,
      marker: change.top ? '-' : item.marker,
      checked: change.checked === undefined ? item.checked : change.checked,
      text: change.text ?? item.text,
      fields: change.fields ?? item.fields,
    },
    label,
  )
}

function requireFitting(item: Item, b: Batch): void {
  const problem = b.copy.note(item.path)!.problems.find((p) => p.line === item.index + 1)
  if (problem) {
    throw new NotebookError(
      'invalid_value',
      `Item ${item.id}'s line doesn't fit the format (${problem.message}) so it can't be changed safely. Rewrite it with update and "text" first, or ask the person to fix it.`,
      { id: item.id, file: item.path, line: item.raw },
    )
  }
}

const notInArchiveOrLog = (i: Item): string | null =>
  ARCHIVE_PATH.test(i.path)
    ? 'is in the archive, which keeps items as they were archived'
    : LOG_PATH.test(i.path)
      ? "is a daily log line; the log isn't edited"
      : null

const notADecision = (i: Item): string | null =>
  i.path === 'decisions.md'
    ? 'is a decision; past decisions aren\'t edited or moved. Record a new one with decide and "supersedes"'
    : null

const either =
  (...checks: ((i: Item) => string | null)[]) =>
  (i: Item): string | null => {
    for (const c of checks) {
      const why = c(i)
      if (why) return why
    }
    return null
  }

function linePrefixDate(text: string): { date: string | null; rest: string } {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(text)
  return m ? { date: m[1]!, rest: m[2]! } : { date: null, rest: text }
}

function leadingPerson(text: string): string | null {
  const m = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]:\s/.exec(text)
  return m ? m[1]!.trim() : null
}

/** An entry for a note, focus line or suggestion: a sentence with names linked, and its src. */
function composeEntry(
  b: Batch,
  entry: Entry,
  opts: { src: boolean; label: string },
): { line: string; lines: string[] } {
  const e = typeof entry === 'string' ? { text: entry } : entry
  const sentence = linkNames(checkSentence(e.text, opts.label), linkTargets(b, e))
  const fields: Field[] = []
  if (opts.src || ('src' in e && e.src !== undefined)) {
    fields.push({
      key: 'src',
      value: buildSrc('src' in e ? e.src : undefined, b.defaultSource, b.today),
    })
  }
  const line = renderChecked({ checked: null, text: sentence, fields }, opts.label)
  const quote = 'quote' in e ? checkQuote(e.quote) : []
  return { line, lines: [line, ...quoteLines(quote)] }
}

function checkTargetPath(b: Batch, path: string, opts: { allowCreate: boolean }): void {
  const problem = pathProblem(path)
  if (problem) throw new NotebookError('invalid_value', `The file "${path}" ${problem}.`)
  if (path === 'brief.md')
    throw new NotebookError('invalid_value', 'brief.md is written with write_brief.')
  b.checkWritable(path)
  const type = noteType(path)
  if (
    !b.copy.has(path) &&
    (!opts.allowCreate ||
      type === 'other' ||
      type === 'person' ||
      type === 'project' ||
      type === 'area' ||
      type === 'draft')
  ) {
    const hint =
      type === 'person' || type === 'project' || type === 'area'
        ? ' Create it first with a note operation earlier in the same call.'
        : ''
    throw new NotebookError('not_found', `There is no note ${path}.${hint}`)
  }
}

function archiveItem(b: Batch, item: Item, why: string): string {
  const quotes = rawQuoteLines(b, item)
  b.removeItem(item)
  let fields = removeField(item.fields, 'why')
  fields = setField(fields, 'archived', b.today)
  fields = setField(fields, 'why', why)
  fields = setField(fields, 'from', item.path.slice(0, -3))
  const line = rerender(item, { fields, top: true })
  const path = archivePath(b.today)
  b.checkWritable(path, { allowArchive: true })
  b.appendToSection(path, undefined, [line, ...quotes])
  return line
}

// ---------- add ----------

async function add(b: Batch, op: OperationOf<'add'>): Promise<void> {
  if (op.kind === 'decision') {
    const { kind: _kind, op: _op, ...rest } = op
    if (
      rest.due ||
      rest.since ||
      rest.back ||
      rest.url ||
      rest.quote ||
      rest.file ||
      rest.section ||
      rest.fields
    ) {
      throw new NotebookError(
        'invalid_value',
        'A decision takes text, person, project, area, why and src. Use the decide operation.',
      )
    }
    return decide(b, {
      op: 'decide',
      text: rest.text,
      person: rest.person,
      project: rest.project,
      area: rest.area,
      why: rest.why,
      src: rest.src,
    })
  }
  const layout = KIND_LAYOUT[op.kind]
  const path = op.file ?? layout.file
  checkTargetPath(b, path, { allowCreate: true })

  let section = op.section ?? layout.section
  let fields: Field[] = []
  if (op.due !== undefined) fields = setField(fields, 'due', checkDate(op.due, 'due'))
  if (op.kind === 'waiting' || op.kind === 'catch_up' || op.since !== undefined) {
    fields = setField(
      fields,
      'since',
      op.since !== undefined ? checkDate(op.since, 'since') : b.today,
    )
  }
  if (op.back !== undefined) fields = setField(fields, 'back', checkFieldValue(op.back, 'back'))
  if (op.why !== undefined) fields = setField(fields, 'why', checkFieldValue(op.why, 'why'))
  for (const [k, v] of Object.entries(op.fields ?? {})) {
    if (['due', 'since', 'back', 'why'].includes(k)) {
      throw new NotebookError('invalid_value', `Pass ${k} as its own value, not inside fields.`)
    }
    const f = checkExtraField(k, v)
    fields = setField(fields, f.key, f.value)
  }
  if (op.kind === 'catch_up') {
    const kind = fields.find((f) => f.key === 'kind')?.value
    if (!kind || !CATCH_UP_SECTIONS[kind]) {
      throw new NotebookError(
        'invalid_value',
        'A catch_up item needs fields.kind: reply, missed or changed.',
      )
    }
    section = op.section ?? CATCH_UP_SECTIONS[kind]
  }
  if (op.kind === 'waiting' && op.person === undefined) {
    throw new NotebookError('invalid_value', 'A waiting item needs "person": who owes it.')
  }

  let sentence = checkSentence(op.text)
  if (op.kind === 'link') {
    if (op.url === undefined) throw new NotebookError('invalid_value', 'A link needs "url".')
    if (!/^https?:\/\/[^\s<>]+$/.test(op.url)) {
      throw new NotebookError(
        'invalid_value',
        'url must be a full http or https address, without spaces.',
      )
    }
    if (/[[\]]/.test(sentence))
      throw new NotebookError('invalid_value', "A link's text can't contain square brackets.")
    const url = op.url.replace(/\(/g, '%28').replace(/\)/g, '%29')
    sentence = `[${sentence}](${url})`
  } else if (op.url !== undefined) {
    throw new NotebookError(
      'invalid_value',
      'Only links take "url". To keep where an item came from, use "src".',
    )
  }
  const targets = linkTargets(b, op)
  sentence = linkNames(sentence, targets, op.kind === 'waiting')
  fields.push({ key: 'src', value: buildSrc(op.src, b.defaultSource, b.today) })

  const checkbox = layout.checkbox
  const line = renderChecked({ checked: checkbox ? false : null, text: sentence, fields })
  const quote = checkQuote(op.quote)

  const open = b.copy.note(path)?.items.filter((i) => i.checked !== true) ?? []
  const want = normalize(sentence)
  const dup = open.find(
    (i) => normalize(i.text) === want || normalize(i.text) === normalize(op.text),
  )
  if (dup) {
    b.status('duplicate')
    b.resultItem(path, dup.raw)
    b.warn(
      'duplicate',
      `An open item in ${path} already says this, so nothing was added. Its id is ${dup.id}.`,
      {
        id: dup.id,
      },
    )
    return
  }
  const likely = open
    .map((i) => ({ i, s: textSimilarity(sentence, i.text) }))
    .filter((x) => x.s >= 0.8)
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
  if (likely.length) {
    b.warn(
      'likely_duplicate',
      `This looks like ${likely.length > 1 ? 'items' : 'an item'} already in ${path}; merge them if they're the same.`,
      {
        candidates: likely.map((x) => ({ id: x.i.id, file: x.i.path, text: x.i.text })),
      },
    )
  }

  b.appendToSection(path, section, [line, ...quoteLines(quote)])
  b.resultItem(path, line)
  b.status('added')
  b.describe(`Added "${shortText(sentence)}" to ${path}`)
}

// ---------- complete ----------

async function complete(b: Batch, op: OperationOf<'complete'>): Promise<void> {
  const item = await b.resolve(op, {
    reject: either(notInArchiveOrLog, (i) =>
      i.checked === null
        ? "isn't a checkbox item, so it can't be completed; archive it instead"
        : null,
    ),
  })
  b.checkWritable(item.path)
  if (item.checked) {
    b.resultItem(item.path, item.raw)
    b.warn('already_done', `Item ${item.id} is already checked off.`, { id: item.id })
    return
  }
  requireFitting(item, b)
  const date = op.date !== undefined ? checkDate(op.date, 'date') : b.today
  const line = rerender(item, {
    checked: true,
    fields: setField(removeField(item.fields, 'done'), 'done', date),
  })
  b.replaceItem(item, [line, ...rawQuoteLines(b, item)])
  b.resultItem(item.path, line, item.id)
  b.status('completed')
  b.describe(`Completed "${shortText(item.text)}" in ${item.path}`)
}

// ---------- update ----------

async function update(b: Batch, op: OperationOf<'update'>): Promise<void> {
  const item = await b.resolve(op, { reject: notInArchiveOrLog })
  b.checkWritable(item.path)
  requireFitting(item, b)
  if (
    item.path === 'decisions.md' &&
    (op.text !== undefined || op.person || op.project || op.area)
  ) {
    throw new NotebookError(
      'invalid_value',
      `Item ${item.id} is a decision; past decisions aren't edited. Record a new one with decide and "supersedes".`,
    )
  }

  let text = item.text
  if (op.text !== undefined) {
    const { date } = linePrefixDate(item.text)
    text = checkSentence(op.text)
    if (date && !DATE.test(text.split(' ')[0]!)) text = `${date} ${text}`
  }
  const targets = linkTargets(b, op)
  const lead = item.path === 'waiting.md' ? leadingPerson(item.text) : null
  if (lead && op.text !== undefined && !targets.some((t) => t.type === 'person')) {
    targets.unshift({ name: lead, type: 'person' })
  }
  if (targets.length) text = linkNames(text, targets, item.path === 'waiting.md')

  let checked = item.checked
  let fields = [...item.fields]
  if (op.done !== undefined) {
    if (item.checked === null)
      throw new NotebookError('invalid_value', `Item ${item.id} isn't a checkbox item.`)
    checked = op.done
    fields = op.done
      ? fields.some((f) => f.key === 'done')
        ? fields
        : setField(fields, 'done', b.today)
      : removeField(fields, 'done')
  }
  for (const [k, v] of Object.entries(op.fields ?? {})) {
    if (v === null) {
      if (RESERVED_FIELDS[k])
        throw new NotebookError(
          'invalid_value',
          `The ${k} field can't be removed: ${RESERVED_FIELDS[k]}.`,
        )
      fields = removeField(fields, k)
    } else {
      const f = checkExtraField(k, v)
      fields = setField(fields, f.key, f.value)
    }
  }
  const quotes = op.quote === undefined ? rawQuoteLines(b, item) : quoteLines(checkQuote(op.quote))
  const line = rerender(item, { checked, text, fields })
  const unchanged = line === item.raw && quotes.join('\n') === rawQuoteLines(b, item).join('\n')
  if (unchanged) {
    b.resultItem(item.path, item.raw)
    return
  }
  b.replaceItem(item, [line, ...quotes])
  b.resultItem(item.path, line, item.id)
  b.status('updated')
  b.describe(`Updated "${shortText(text)}" in ${item.path}`)
}

// ---------- archive ----------

async function archive(b: Batch, op: OperationOf<'archive'>): Promise<void> {
  const item = await b.resolve(op, {
    reject: either(notInArchiveOrLog, (i) =>
      i.path === 'decisions.md'
        ? 'is a decision; decisions are kept, and a replaced one is marked superseded (decide with "supersedes")'
        : null,
    ),
  })
  b.checkWritable(item.path)
  requireFitting(item, b)
  const why = checkFieldValue(op.why, 'why')
  const line = archiveItem(b, item, why)
  b.resultItem(archivePath(b.today), line, item.id)
  b.status('archived')
  b.describe(`Archived "${shortText(item.text)}" from ${item.path} (${why})`)
}

// ---------- move ----------

async function move(b: Batch, op: OperationOf<'move'>): Promise<void> {
  if (op.to_file === undefined && op.project === undefined && op.area === undefined) {
    throw new NotebookError('invalid_value', 'move needs "to_file", "project" or "area".')
  }
  const item = await b.resolve(op, { reject: either(notInArchiveOrLog, notADecision) })
  b.checkWritable(item.path)
  requireFitting(item, b)
  const dest = op.to_file ?? item.path
  const destKind = kindOfFile(dest)
  const targets = linkTargets(b, op)
  const toWaiting = dest === 'waiting.md' && item.path !== 'waiting.md'
  if (toWaiting && !leadingPerson(item.text) && !targets.some((t) => t.type === 'person')) {
    throw new NotebookError(
      'invalid_value',
      'A waiting item starts with who owes it; pass "person".',
    )
  }
  const text = targets.length ? linkNames(item.text, targets, toWaiting) : item.text

  if (dest === item.path && op.section === undefined) {
    const line = rerender(item, { text })
    if (line === item.raw) {
      b.resultItem(item.path, item.raw)
      return
    }
    b.replaceItem(item, [line, ...rawQuoteLines(b, item)])
    b.resultItem(item.path, line, item.id)
    b.status('updated')
    b.describe(`Linked "${shortText(text)}" to ${targets.map((t) => `[[${t.name}]]`).join(', ')}`)
    return
  }

  checkTargetPath(b, dest, { allowCreate: true })
  let checked = item.checked
  if (destKind) checked = KIND_LAYOUT[destKind].checkbox ? (item.checked ?? false) : null
  const type = noteType(dest)
  let section = op.section
  if (section === undefined) {
    if (destKind === 'catch_up') {
      section =
        CATCH_UP_SECTIONS[item.fields.find((f) => f.key === 'kind')?.value ?? ''] ??
        'Needs your reply'
    } else if (destKind) section = KIND_LAYOUT[destKind].section
    else if (type === 'project' || type === 'area') section = 'Notes'
  }
  const quotes = rawQuoteLines(b, item)
  const line = rerender(item, { text, checked, top: true })
  b.removeItem(item)
  b.appendToSection(dest, section, [line, ...quotes])
  b.resultItem(dest, line, item.id)
  b.status('moved')
  b.describe(`Moved "${shortText(text)}" from ${item.path} to ${dest}`)
}

// ---------- decide ----------

async function decide(b: Batch, op: OperationOf<'decide'>): Promise<void> {
  const path = 'decisions.md'
  b.checkWritable(path)
  const date = op.date !== undefined ? checkDate(op.date, 'date') : b.today
  const sentence = linkNames(linePrefixDate(checkSentence(op.text)).rest, linkTargets(b, op))
  let fields: Field[] = []
  if (op.why !== undefined) fields = setField(fields, 'why', checkFieldValue(op.why, 'why'))
  fields.push({ key: 'src', value: buildSrc(op.src, b.defaultSource, b.today) })
  const line = renderChecked({ checked: null, text: `${date} ${sentence}`, fields })

  const current = (b.copy.note(path)?.items ?? []).filter(
    (i) => !i.fields.some((f) => f.key === 'superseded'),
  )
  const dup = current.find((i) => normalize(linePrefixDate(i.text).rest) === normalize(sentence))
  if (dup && !op.supersedes) {
    b.status('duplicate')
    b.resultItem(path, dup.raw)
    b.warn('duplicate', `This decision is already recorded (${dup.id}), so nothing was added.`, {
      id: dup.id,
    })
    return
  }

  if (op.supersedes) {
    const old = await b.resolve(op.supersedes, {
      scope: (p) => p === path,
      reject: (i) => (i.path !== path ? "isn't in decisions.md" : null),
    })
    if (old.fields.some((f) => f.key === 'superseded')) {
      b.warn('already_superseded', `Decision ${old.id} was already marked superseded.`, {
        id: old.id,
      })
    } else {
      requireFitting(old, b)
      const oldLine = rerender(old, { fields: setField(old.fields, 'superseded', b.today) })
      b.replaceItem(old, [oldLine, ...rawQuoteLines(b, old)])
      b.resultItem(path, oldLine, old.id)
    }
  }
  b.appendToSection(path, undefined, [line])
  b.resultItem(path, line)
  b.status('added')
  b.describe(`Decided "${shortText(sentence)}"`)
}

// ---------- note ----------

function frontMatterValues(
  b: Batch,
  type: string,
  values: Record<string, string | number | null>,
): [string, string | null][] {
  return Object.entries(values).map(([k, v]) => {
    if (!KEY.test(k)) {
      throw new NotebookError(
        'invalid_value',
        `"${k}" isn't a front matter key: use lowercase letters, digits and _.`,
      )
    }
    // Removing is always allowed, so a stray value in a work notebook can be cleaned up.
    if (v === null) return [k, null]
    if (
      type === 'my-rules' &&
      b.notebook.space.kind === 'workspace' &&
      PERSONAL_ONLY_SETTINGS.includes(k)
    ) {
      throw new NotebookError(
        'invalid_value',
        `${k} is the person's own preference, so it's set in their personal notebook's my-rules.md, not a work notebook's.`,
      )
    }
    if (k === 'same_as') checkSameAsAllowed(b)
    const value = checkText(String(v), k, k === 'same_as' ? SAME_AS_MAX_CHARS : 300)
    const problem = frontMatterProblem(type, k, value)
    if (problem) throw new NotebookError('invalid_value', `${problem}.`)
    return [k, value]
  })
}

/** Cross-links between spaces live only in the personal notebook, so no workspace learns of another space. */
function checkSameAsAllowed(b: Batch): void {
  if (b.notebook.space.kind !== 'personal') {
    throw new NotebookError(
      'invalid_value',
      "Links to the same person in other notebooks (same_as) are kept only in the person's personal notebook, so no workspace learns about their other spaces. Add the link there instead.",
    )
  }
}

const SAME_AS_MAX_CHARS = 4000

/**
 * The person note's same_as value with `links` added to the ones it has, or null when every
 * link is already there. Each link must name a work notebook and a valid note name. A same_as
 * line with parts that aren't links is refused rather than overwritten, so nothing is lost.
 */
function mergedSameAs(
  b: Batch,
  current: string | undefined,
  links: readonly { notebook: string; name: string }[],
): string | null {
  checkSameAsAllowed(b)
  const parsed = current !== undefined ? parseSameAs(current) : { links: [], invalid: [] }
  if (parsed.invalid.length) {
    throw new NotebookError(
      'invalid_value',
      `This note's same_as line has parts that aren't links ("${parsed.invalid[0]}"), so adding to it could lose them. Read the note, then set front_matter.same_as to the full, corrected list.`,
    )
  }
  const all = [...parsed.links]
  let added = false
  links.forEach((link, i) => {
    const notebook = link.notebook.trim()
    if (!WORK_NOTEBOOK.test(notebook)) {
      throw new NotebookError(
        'invalid_value',
        notebook.startsWith('personal:')
          ? `same_as link ${i + 1} points to "${notebook}", which isn't a work notebook. Links go from the personal notebook to work notebooks only.`
          : `same_as link ${i + 1}: "${notebook}" isn't a work notebook name; they look like workspace:northwind:alex.`,
      )
    }
    const name = cleanName(link.name)
    const problem = nameProblem(name)
    if (problem) {
      throw new NotebookError(
        'invalid_value',
        `same_as link ${i + 1}: the name "${link.name}" ${problem}.`,
      )
    }
    if (!all.some((l) => l.notebook === notebook && l.name === name)) {
      all.push({ notebook, name })
      added = true
    }
  })
  if (!added) return null
  if (all.length > SAME_AS_MAX_LINKS) {
    throw new NotebookError(
      'invalid_value',
      `A person note can have at most ${SAME_AS_MAX_LINKS} same_as links.`,
    )
  }
  return checkText(renderSameAs(all), 'same_as', SAME_AS_MAX_CHARS)
}

function createNamedNote(
  b: Batch,
  path: string,
  name: string,
  front: [string, string | null][],
): void {
  const entries = front.filter((e): e is [string, string] => e[1] !== null)
  const lines = entries.length
    ? ['---', ...entries.map(([k, v]) => renderFrontMatterEntry(k, v)), '---']
    : []
  b.ensureNote(path, [...lines, `# ${name}`])
}

async function note(b: Batch, op: OperationOf<'note'>): Promise<void> {
  let path: string
  let name: string | null = null
  let type: string
  if (op.file !== undefined) {
    if (op.type !== undefined || op.name !== undefined) {
      throw new NotebookError(
        'invalid_value',
        'Name the note with "file", or with "type" and "name", not both.',
      )
    }
    path = op.file
    type = noteType(path)
    if (path === 'my-rules.md')
      throw new NotebookError('invalid_value', 'my-rules.md is changed with the rule operation.')
    checkTargetPath(b, path, { allowCreate: true })
    b.ensureNote(path)
  } else {
    if (op.type === undefined || op.name === undefined) {
      throw new NotebookError(
        'invalid_value',
        'A note operation needs "type" (person, project or area) and "name", or "file".',
      )
    }
    type = op.type
    name = b.resolveName(op.name, op.type)
    path = namedNotePath(op.type as NamedNoteType, name)
    b.checkWritable(path)
  }

  let front = frontMatterValues(b, type, op.front_matter ?? {})
  if (op.same_as) {
    if (type !== 'person') {
      throw new NotebookError('invalid_value', 'same_as links are for person notes.')
    }
    const given = front.find(([k]) => k === 'same_as')
    const current = given
      ? (given[1] ?? undefined)
      : frontMatterValue(b.copy.note(path)?.frontMatter ?? null, 'same_as')
    const merged = mergedSameAs(b, current, op.same_as)
    if (merged !== null) front = [...front.filter(([k]) => k !== 'same_as'), ['same_as', merged]]
  }
  let status = 'unchanged'
  if (!b.copy.has(path) && name !== null) {
    const withDefaults =
      type === 'project' && !front.some(([k]) => k === 'status')
        ? [['status', 'active'] as [string, string], ...front]
        : front
    createNamedNote(b, path, name, withDefaults)
    status = 'created'
  } else {
    for (const [k, v] of front) if (b.setFrontMatter(path, k, v)) status = 'updated'
  }
  if (op.append?.length) {
    const lines: string[] = []
    const written: string[] = []
    for (const entry of op.append) {
      const e = composeEntry(b, entry, { src: true, label: 'append' })
      lines.push(...e.lines)
      written.push(e.line)
    }
    b.appendToSection(path, op.section, lines)
    for (const l of written) b.resultItem(path, l)
    if (status === 'unchanged') status = 'updated'
  } else if (op.section !== undefined) {
    throw new NotebookError(
      'invalid_value',
      '"section" goes with "append": the lines to add to that section.',
    )
  }
  b.status(status)
  if (status === 'created') b.describe(`Created ${path}`)
  else if (status === 'updated') b.describe(`Updated ${path}`)
}

// ---------- merge ----------

async function merge(b: Batch, op: OperationOf<'merge'>): Promise<void> {
  const items: Item[] = []
  for (const t of op.items) {
    const item = await b.resolve(t, { reject: either(notInArchiveOrLog, notADecision) })
    if (items.some((i) => i.id === item.id)) {
      throw new NotebookError(
        'invalid_value',
        `Item ${item.id} is named twice; merge needs different items.`,
      )
    }
    b.checkWritable(item.path)
    requireFitting(item, b)
    items.push(item)
  }
  const [keep, ...others] = items as [Item, ...Item[]]
  let fields = [...keep.fields]
  const quotes = rawQuoteLines(b, keep)
  for (const other of others) {
    for (const f of other.fields) {
      if (f.key === 'src') {
        if (!fields.some((g) => g.key === 'src' && g.value === f.value)) fields.push(f)
      } else if (f.key !== 'done' && !fields.some((g) => g.key === f.key)) {
        fields = setField(fields, f.key, f.value)
      }
    }
    for (const q of rawQuoteLines(b, other))
      if (!quotes.some((x) => x.trim() === q.trim())) quotes.push(q)
  }
  const text = op.text !== undefined ? checkSentence(op.text) : keep.text
  const line = rerender(keep, { text, fields })
  b.replaceItem(keep, [line, ...quotes])
  for (const other of others) {
    const current = b.copy.findById(other.id)
    if (current) archiveItem(b, current, 'merged')
  }
  b.resultItem(keep.path, line, keep.id)
  b.status('merged')
  b.describe(`Merged ${items.length} items into "${shortText(text)}"`)
}

// ---------- promote ----------

async function promote(b: Batch, op: OperationOf<'promote'>): Promise<void> {
  const item = await b.resolve(op, { reject: either(notInArchiveOrLog, notADecision) })
  b.checkWritable(item.path)
  requireFitting(item, b)
  const name = b.resolveName(op.project, 'project')
  const path = namedNotePath('project', name)
  b.checkWritable(path)
  const front = frontMatterValues(b, 'project', op.front_matter ?? {})
  const quotes = rawQuoteLines(b, item)
  const line = rerender(item, { top: true })
  b.removeItem(item)
  if (!b.copy.has(path)) {
    createNamedNote(
      b,
      path,
      name,
      front.some(([k]) => k === 'status') ? front : [['status', 'active'], ...front],
    )
  } else {
    b.warn('existing_project', `[[${name}]] already has a note; the item was added to it.`)
    for (const [k, v] of front) b.setFrontMatter(path, k, v)
  }
  b.appendToSection(path, 'Notes', [line, ...quotes])
  b.resultItem(path, line, item.id)
  b.status('promoted')
  b.describe(`Promoted "${shortText(item.text)}" from ${item.path} to [[${name}]]`)
}

// ---------- set_focus ----------

function replaceSectionItems(b: Batch, path: string, section: string, lines: string[]): void {
  const note = b.ensureNote(path)
  const heading = note.headings.find((h) => h.title.toLowerCase() === section.toLowerCase())
  if (heading) {
    const next = note.headings.find((h) => h.index > heading.index && h.level <= heading.level)
    const end = next ? next.index : note.text.length
    const inside = note.items.filter((i) => i.index > heading.index && i.index < end)
    for (const item of inside.reverse()) b.removeItem(item)
  }
  if (lines.length) b.appendToSection(path, section, lines)
}

async function setFocus(b: Batch, op: OperationOf<'set_focus'>): Promise<void> {
  const path = 'now.md'
  b.checkWritable(path)
  if (op.focus === undefined && op.this_week === undefined && op.suggest === undefined) {
    throw new NotebookError('invalid_value', 'set_focus needs "focus", "this_week" or "suggest".')
  }
  b.ensureNote(path)
  const parts: string[] = []
  if (op.focus !== undefined) {
    const lines = op.focus.map((e) => composeEntry(b, e, { src: false, label: 'focus' }).line)
    replaceSectionItems(b, path, 'Focus', lines)
    lines.forEach((l) => b.resultItem(path, l))
    parts.push('focus')
  }
  if (op.this_week !== undefined) {
    const entries = op.this_week
      .map((e) => ({
        date: checkDate(e.date, 'this_week date'),
        text: linkNames(checkSentence(e.text, 'this_week text'), linkTargets(b, e)),
      }))
      .sort((x, y) => x.date.localeCompare(y.date))
    const lines = entries.map((e) =>
      renderChecked({ checked: null, text: `${e.date} ${e.text}`, fields: [] }, 'this_week text'),
    )
    replaceSectionItems(b, path, 'This week', lines)
    lines.forEach((l) => b.resultItem(path, l))
    parts.push("this week's dates")
  }
  if (op.suggest !== undefined) {
    const e = composeEntry(b, op.suggest, { src: true, label: 'suggest' })
    const section = b.copy
      .note(path)!
      .headings.find((h) => h.title.toLowerCase() === 'suggested moves')
    const existing = b.copy
      .note(path)!
      .items.find(
        (i) =>
          section &&
          i.section.includes(section.title) &&
          normalize(i.text) === normalize(parseItemText(e.line)),
      )
    if (existing) {
      b.warn('duplicate', `That suggestion is already in now.md (${existing.id}).`, {
        id: existing.id,
      })
      b.resultItem(path, existing.raw)
    } else {
      b.appendToSection(path, 'Suggested moves', e.lines)
      b.resultItem(path, e.line)
      parts.push('a suggested move')
    }
  }
  if (parts.length) {
    b.status('updated')
    b.describe(`Updated ${parts.join(', ')} in now.md`)
  }
}

function parseItemText(line: string): string {
  return line.replace(/^- /, '').replace(/\s*\[[a-z][a-z0-9_]*::[^\]]*\]/g, '')
}

// ---------- rule ----------

async function rule(b: Batch, op: OperationOf<'rule'>): Promise<void> {
  const path = 'my-rules.md'
  b.checkWritable(path)
  const hasTarget = op.id !== undefined || op.match !== undefined
  if (!op.settings && op.text === undefined && !hasTarget) {
    throw new NotebookError(
      'invalid_value',
      'rule needs "text" (a new rule), "settings", or an id or match with the change.',
    )
  }
  if (op.file !== undefined && op.file !== path) {
    throw new NotebookError('invalid_value', 'Rules live in my-rules.md.')
  }
  const personalOnly = (section: string | undefined) =>
    b.notebook.space.kind === 'workspace' &&
    section !== undefined &&
    PERSONAL_ONLY_SECTIONS.some((p) => p.toLowerCase() === section.toLowerCase())
  if (personalOnly(op.section)) {
    throw new NotebookError(
      'invalid_value',
      `"${op.section}" is the person's own, so it lives in their personal notebook's my-rules.md, not a work notebook's.`,
    )
  }
  b.ensureNote(path)
  const changed: string[] = []
  if (op.settings) {
    for (const [k, v] of frontMatterValues(b, 'my-rules', op.settings)) {
      if (b.setFrontMatter(path, k, v)) changed.push(k)
    }
    if (changed.length) b.describe(`Changed ${changed.join(', ')} in my-rules.md`)
  }
  const extra = Object.entries(op.fields ?? {}).map(([k, v]) => checkExtraField(k, v))
  if (hasTarget) {
    const item = await b.resolve(
      { ...op, file: path },
      { reject: (i) => (i.path !== path ? "isn't in my-rules.md" : null) },
    )
    if (personalOnly(item.section.at(-1))) {
      throw new NotebookError(
        'invalid_value',
        `Item ${item.id} is under "${item.section.at(-1)}", which belongs in the personal notebook. Change it there.`,
      )
    }
    requireFitting(item, b)
    let fields = [...item.fields]
    if (op.replaces !== undefined)
      fields = setField(fields, 'replaces', checkFieldValue(op.replaces, 'replaces'))
    for (const f of extra) fields = setField(fields, f.key, f.value)
    const text = op.text !== undefined ? checkSentence(op.text) : item.text
    const line = rerender(item, { text, fields })
    if (line !== item.raw) {
      b.replaceItem(item, [line, ...rawQuoteLines(b, item)])
      b.resultItem(path, line, item.id)
      b.describe(`Changed a rule in my-rules.md: "${shortText(text)}"`)
      changed.push('rule')
    } else {
      b.resultItem(path, item.raw)
    }
  } else if (op.text !== undefined) {
    const sentence = checkSentence(op.text)
    let fields: Field[] = []
    if (op.replaces !== undefined)
      fields = setField(fields, 'replaces', checkFieldValue(op.replaces, 'replaces'))
    for (const f of extra) fields = setField(fields, f.key, f.value)
    fields.push({ key: 'src', value: buildSrc(op.src, b.defaultSource, b.today) })
    const line = renderChecked({ checked: null, text: sentence, fields })
    const dup = b.copy.note(path)!.items.find((i) => normalize(i.text) === normalize(sentence))
    if (dup) {
      b.warn('duplicate', `my-rules.md already has this rule (${dup.id}).`, { id: dup.id })
      b.resultItem(path, dup.raw)
    } else {
      b.appendToSection(path, op.section ?? 'My rules', [line])
      b.resultItem(path, line)
      b.describe(`Added a rule to my-rules.md: "${shortText(sentence)}"`)
      changed.push('rule')
    }
  }
  b.status(changed.length ? 'updated' : 'unchanged')
}

// ---------- log ----------

async function log(b: Batch, op: OperationOf<'log'>): Promise<void> {
  const path = logPath(b.today)
  b.checkWritable(path, { allowLog: true })
  const sentence = linkNames(checkSentence(op.text), linkTargets(b, op))
  const fields: Field[] = [{ key: 'by', value: b.label() }]
  if (op.src !== undefined)
    fields.push({ key: 'src', value: buildSrc(op.src, b.defaultSource, b.today) })
  const line = renderChecked({ checked: null, text: `${b.now.time} ${sentence}`, fields })
  if (!b.copy.has(path)) b.ensureNote(path, newNoteLines(path))
  b.appendToSection(path, undefined, [line])
  b.resultItem(path, line)
  b.status('logged')
}

// ---------- identify ----------

/**
 * Records an id a client uses for this workspace, so later calls can name the workspace the
 * client's way. It only adds to `workspace_ids` in this work notebook's my-rules.md, which
 * needs no rules:write scope: it changes no rule.
 */
async function identify(b: Batch, op: OperationOf<'identify'>): Promise<void> {
  if (b.notebook.space.kind !== 'workspace') {
    throw new NotebookError(
      'invalid_value',
      "Workspace ids are recorded in a work notebook, to match a client's workspace to it.",
    )
  }
  const source = op.source.trim()
  const id = op.id.trim()
  if (!WORKSPACE_ID_SOURCE.test(source)) {
    throw new NotebookError(
      'invalid_value',
      'source is a short lowercase word, like slack, google or cv.',
    )
  }
  if (!WORKSPACE_ID_VALUE.test(id)) {
    throw new NotebookError(
      'invalid_value',
      "id is the client's id for the workspace, without spaces, quotes, brackets or |.",
    )
  }
  checkNoSecret(id, 'id')
  const path = 'my-rules.md'
  b.checkWritable(path, { withoutRulesScope: true })
  const current = frontMatterValue(b.copy.note(path)?.frontMatter ?? null, 'workspace_ids')
  const parsed = current !== undefined ? parseWorkspaceIds(current) : { ids: [], invalid: [] }
  if (parsed.invalid.length) {
    throw new NotebookError(
      'invalid_value',
      `my-rules.md's workspace_ids has a part that isn't "<source>:<id>" ("${parsed.invalid[0]}"). Fix it first.`,
    )
  }
  if (parsed.ids.some((x) => x.source === source && x.id === id)) return
  b.setFrontMatter(path, 'workspace_ids', renderWorkspaceIds([...parsed.ids, { source, id }]))
  b.status('updated')
  b.describe(`Recorded the ${source} id for this workspace`)
}

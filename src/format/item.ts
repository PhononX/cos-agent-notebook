// One list line: `- [ ] The sentence with [[Links]] [key:: value] [src:: cv 2026-10-13]`.
// Reading is tolerant (anything that starts like a list line is an item, and what doesn't fit is
// reported); rendering always produces a line that fits the format.

export interface Field {
  key: string
  value: string
}

export interface ItemLine {
  indent: string
  marker: string
  /** null when the line has no checkbox. */
  checked: boolean | null
  /** The sentence: the line without its marker, checkbox and fields, trimmed. */
  text: string
  fields: Field[]
  /** Link targets in the sentence and in field values, in order, without duplicates. */
  links: string[]
  problems: string[]
}

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const CHECKBOX = /^\[([ xX])\](?:[ \t]+|$)/
// A field value may hold [[links]] but no other square brackets.
const FIELD = /\[([a-z][a-z0-9_]*)::(?:[ \t]+((?:[^[\]]|\[\[[^[\]]*\]\])*?))?[ \t]*\]/g
const LINK = /\[\[([^[\]]*)\]\]/g
const ONE_COLON_FIELD = /\[[a-z][a-z0-9_]*:(?!:)[ \t]/
const OPEN_FIELD = /\[[a-z][a-z0-9_]*::/

export function parseItemLine(line: string): ItemLine | null {
  const m = ITEM.exec(line)
  if (!m) return null
  const indent = m[1]!
  const marker = m[2]!
  let body = m[3]!
  if (body.trim() === '') return null
  let checked: boolean | null = null
  const box = CHECKBOX.exec(body)
  if (box) {
    checked = box[1] !== ' '
    body = body.slice(box[0].length)
  }

  const problems: string[] = []
  const fields: Field[] = []
  const pieces: string[] = []
  let last = 0
  let textAfterField = false
  for (const f of body.matchAll(FIELD)) {
    const before = body.slice(last, f.index)
    if (before.trim() !== '') {
      if (fields.length > 0) textAfterField = true
      pieces.push(before)
    }
    fields.push({ key: f[1]!, value: (f[2] ?? '').trim() })
    last = f.index + f[0].length
  }
  const rest = body.slice(last)
  if (rest.trim() !== '') {
    if (fields.length > 0) textAfterField = true
    pieces.push(rest)
  }
  const text = pieces.map((p) => p.trim()).join(' ')
  if (textAfterField) problems.push('Fields should come after the sentence.')
  if (OPEN_FIELD.test(stripFields(text))) problems.push("A field isn't closed with ].")
  if (ONE_COLON_FIELD.test(text)) {
    problems.push('Something looks like a field with one colon; fields are [key:: value].')
  }
  if (unbalancedLinks(text)) problems.push("A [[link]] isn't closed.")

  return { indent, marker, checked, text, fields, links: linksIn(body), problems }
}

function stripFields(s: string): string {
  return s.replace(FIELD, '')
}

function unbalancedLinks(s: string): boolean {
  const without = s.replace(LINK, '')
  return without.includes('[[') || without.includes(']]')
}

/** Link targets in a piece of text: `[[Name]]`, `[[Name|alias]]`, `[[Name#heading]]`. */
export function linksIn(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(LINK)) {
    const target = m[1]!.split('|')[0]!.split('#')[0]!.split('^')[0]!.trim()
    if (target && !out.includes(target)) out.push(target)
  }
  return out
}

export function fieldValue(fields: readonly Field[], key: string): string | undefined {
  return fields.find((f) => f.key === key)?.value
}

export interface RenderItem {
  indent?: string
  marker?: string
  checked: boolean | null
  text: string
  fields: readonly Field[]
}

export function renderItem(item: RenderItem): string {
  const box = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] '
  const fields = item.fields.map((f) => ` [${f.key}:: ${f.value}]`).join('')
  return `${item.indent ?? ''}${item.marker ?? '-'} ${box}${item.text}${fields}`
}

// The order fields are written in. Keys not listed keep their place after these, and `src`
// always goes last.
const FIELD_ORDER = [
  'due',
  'since',
  'nudged',
  'back',
  'kind',
  'raised',
  'prep',
  'at',
  'days',
  'covers',
  'for',
  'audience',
  'status',
  'via',
  'reads',
  'replaces',
  'why',
  'superseded',
  'done',
  'archived',
  'from',
  'by',
  'change',
]

/**
 * Sets a field: replaces the first field with that key in place, or inserts it where the
 * canonical order puts it among the line's existing fields (always before `src`).
 */
export function setField(fields: readonly Field[], key: string, value: string): Field[] {
  const out = [...fields]
  const at = out.findIndex((f) => f.key === key)
  if (at >= 0) {
    out[at] = { key, value }
    return out
  }
  const rank = (k: string) => (k === 'src' ? Infinity : FIELD_ORDER.indexOf(k))
  const mine = rank(key)
  let insertAt = out.length
  for (let i = 0; i < out.length; i++) {
    const r = rank(out[i]!.key)
    if (out[i]!.key === 'src' || (mine >= 0 && r > mine)) {
      insertAt = i
      break
    }
  }
  out.splice(insertAt, 0, { key, value })
  return out
}

export function removeField(fields: readonly Field[], key: string): Field[] {
  return fields.filter((f) => f.key !== key)
}

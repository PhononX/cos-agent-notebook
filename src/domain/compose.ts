// Turning structured fields into lines: checking text, linking names inside the sentence, and
// building `src`. Agents never format lines by hand; this is where the format is enforced.

import { parseItemLine, renderItem, type RenderItem } from '../format/item.ts'
import { isDate, parseSrc, renderSrc } from '../format/values.ts'
import { NotebookError } from './errors.ts'
import { findSecret } from './secrets.ts'

const FIELD_SYNTAX = /\[[a-z][a-z0-9_]*::/
const LEADING_MARKER = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:\[[ xX]\]\s+)?/

/** Checks one line of text an agent passed, and returns it trimmed. */
export function checkText(value: string, label: string, max = 1000): string {
  if (/[\r\n]/.test(value)) {
    throw new NotebookError('invalid_value', `${label} must be one line; put extra lines in quote.`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    throw new NotebookError('invalid_value', `${label} has control characters.`)
  }
  const text = value.trim()
  if (!text) throw new NotebookError('invalid_value', `${label} is empty.`)
  if (text.length > max) {
    throw new NotebookError(
      'invalid_value',
      `${label} is longer than ${max} characters; shorten it.`,
    )
  }
  if (FIELD_SYNTAX.test(text)) {
    throw new NotebookError(
      'invalid_value',
      `${label} contains a [key:: value] field. Pass fields as separate values (due, since, src…), not inside the text.`,
    )
  }
  checkNoSecret(text, label)
  return text
}

export function checkNoSecret(text: string, label: string): void {
  const kind = findSecret(text)
  if (kind) {
    throw new NotebookError(
      'secret',
      `${label} looks like it contains ${kind}. Passwords, access codes and keys never go in the notebook; store where to find it instead ("the key is in the team password manager").`,
      { secret_kind: kind },
    )
  }
}

/** An item's sentence, without a list marker or checkbox the agent may have typed. */
export function checkSentence(value: string, label = 'text'): string {
  return checkText(value.replace(LEADING_MARKER, ''), label)
}

export function checkQuote(value: string | string[] | undefined | null, label = 'quote'): string[] {
  if (value == null) return []
  const lines = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(/\r?\n/))
  return lines.map((l) => {
    checkNoSecret(l, label)
    if (l.length > 2000)
      throw new NotebookError('invalid_value', `${label} has a line over 2000 characters.`)
    return l.trimEnd()
  })
}

export function checkDate(value: string, label: string): string {
  if (!isDate(value)) {
    throw new NotebookError(
      'invalid_value',
      `${label} must be a date, YYYY-MM-DD, like 2026-10-16. Turn words like "Friday" into a date first.`,
    )
  }
  return value
}

/** A one-line field value: no square brackets except links. */
export function checkFieldValue(value: string, label: string): string {
  const v = checkText(value, label, 300)
  const withoutLinks = v.replace(/\[\[[^[\]]*\]\]/g, '')
  if (/[[\]]/.test(withoutLinks)) {
    throw new NotebookError(
      'invalid_value',
      `${label} can't contain square brackets, except in [[links]].`,
    )
  }
  return v
}

/** A name as an agent may pass it, `[[Dana Whitfield]]` or with stray spaces, reduced to the name. */
export function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/^\[\[(.*)\]\]$/, '$1')
    .trim()
}

/** Builds a `src` value: the given source (with today's date added if it has none), or the actor's default. */
export function buildSrc(given: string | undefined, fallback: string, today: string): string {
  const raw = (given ?? fallback).trim()
  const src = parseSrc(raw)
  if (!src) {
    throw new NotebookError(
      'invalid_value',
      'src must be a short lowercase source name, then optionally a date YYYY-MM-DD and a link: "gmail 2026-10-12 https://mail.example.com/…".',
    )
  }
  checkNoSecret(raw, 'src')
  return renderSrc({ ...src, date: src.date ?? today })
}

export interface LinkTarget {
  name: string
  type: 'person' | 'project' | 'area'
}

/**
 * Links each name inside the sentence where it already appears (the full name, or a person's
 * first name), and otherwise adds it at the end: "for [[Project]]", "with [[Person]]".
 * With `personFirst`, the first person leads the line as `[[Person]]: …` (waiting items).
 */
export function linkNames(
  sentence: string,
  targets: readonly LinkTarget[],
  personFirst = false,
): string {
  let text = sentence
  const suffix: string[] = []
  let lead: string | null = null
  for (const t of targets) {
    if (personFirst && t.type === 'person' && lead === null) {
      lead = t.name
      text = stripLeadingName(text, t.name)
      continue
    }
    if (hasLink(text, t.name)) continue
    const linked =
      linkInPlace(text, t.name) ?? (t.type === 'person' ? linkFirstName(text, t.name) : null)
    if (linked !== null) {
      text = linked
      continue
    }
    suffix.push(t.type === 'person' ? `with [[${t.name}]]` : `for [[${t.name}]]`)
  }
  if (suffix.length) text = `${text} ${suffix.join(' ')}`
  if (lead !== null) text = `[[${lead}]]: ${text}`
  return text
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasLink(text: string, name: string): boolean {
  return new RegExp(`\\[\\[${escapeRegExp(name)}(?:[|#][^\\]]*)?\\]\\]`, 'i').test(text)
}

/** Ranges inside [[links]] and [label](url) links, where names must not be linked again. */
function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = []
  for (const m of text.matchAll(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)/g))
    out.push([m.index, m.index + m[0].length])
  return out
}

function replaceUnprotected(
  text: string,
  pattern: RegExp,
  name: string,
  onlyIfUnique: boolean,
): string | null {
  const ranges = protectedRanges(text)
  const hits = [...text.matchAll(pattern)].filter(
    (m) => !ranges.some(([a, b]) => m.index >= a && m.index < b),
  )
  if (!hits.length || (onlyIfUnique && hits.length > 1)) return null
  const m = hits[0]!
  return `${text.slice(0, m.index)}[[${name}]]${text.slice(m.index + m[0].length)}`
}

function linkInPlace(text: string, name: string): string | null {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu')
  return replaceUnprotected(text, pattern, name, false)
}

function linkFirstName(text: string, name: string): string | null {
  const first = name.split(/\s+/)[0]!
  if (first.length < 2 || first === name) return null
  // Case-sensitive, and only when the first name appears once: "Dana" → [[Dana Whitfield]].
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(first)}(?![\\p{L}\\p{N}'’])`, 'gu')
  return replaceUnprotected(text, pattern, name, true)
}

function stripLeadingName(text: string, name: string): string {
  const first = escapeRegExp(name.split(/\s+/)[0]!)
  const full = escapeRegExp(name)
  const re = new RegExp(
    `^(?:\\[\\[${full}(?:\\|[^\\]]*)?\\]\\]|${full}|${first})\\s*[:,–—-]?\\s+`,
    'iu',
  )
  const stripped = text.replace(re, '')
  return stripped || text
}

/** Renders an item line and makes sure it reads back exactly as intended. */
export function renderChecked(item: RenderItem, label = 'text'): string {
  const line = renderItem(item)
  const back = parseItemLine(line)
  if (
    !back ||
    back.problems.length ||
    back.text !== item.text ||
    back.fields.length !== item.fields.length
  ) {
    const why = back?.problems[0] ?? "it wouldn't read back as one item"
    throw new NotebookError(
      'invalid_value',
      `The ${label} can't be written as a valid line: ${why}`,
    )
  }
  return line
}

/** A short, log-friendly version of an item's sentence. */
export function shortText(text: string, max = 60): string {
  if (text.length <= max) return text
  let cut = text.slice(0, max - 1)
  const open = cut.lastIndexOf('[[')
  if (open >= 0 && cut.indexOf(']]', open) < 0) cut = cut.slice(0, open)
  const space = cut.lastIndexOf(' ')
  if (space > max / 2) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}

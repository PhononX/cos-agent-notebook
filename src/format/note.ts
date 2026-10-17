// A whole note: its lines (kept byte for byte), front matter, headings, items with ids, and the
// lines that don't fit the format. Parsing never fails; serializing gives back the exact bytes.

import { parseFrontMatter, type FrontMatter } from './front-matter.ts'
import { itemId } from './ids.ts'
import { parseItemLine, type Field } from './item.ts'
import { noteType, type NoteType } from './layout.ts'
import { TextLines } from './lines.ts'
import { fieldValueProblem, frontMatterProblem } from './values.ts'

export interface Heading {
  /** Index of the heading's line (0-based). */
  index: number
  level: number
  title: string
  fields: Field[]
}

export interface Item {
  id: string
  path: string
  /** Index of the item's line (0-based). */
  index: number
  /** How many quote lines follow it. */
  quoteCount: number
  raw: string
  indent: string
  marker: string
  checked: boolean | null
  text: string
  fields: Field[]
  links: string[]
  quote: string[]
  /** Titles of the headings the item sits under, outermost first. */
  section: string[]
}

export interface Problem {
  path: string
  /** Line number, counting from 1. */
  line: number
  message: string
}

export interface Note {
  path: string
  type: NoteType
  text: TextLines
  frontMatter: FrontMatter | null
  headings: Heading[]
  items: Item[]
  problems: Problem[]
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
const QUOTE = /^[ \t]+> ?(.*)$/
const FENCE = /^[ \t]*(```|~~~)/
const HEADING_FIELD = /[ \t]*\[([a-z][a-z0-9_]*)::[ \t]*([^[\]]*?)[ \t]*\]/g

export function parseNote(path: string, content: string | TextLines): Note {
  const text = typeof content === 'string' ? TextLines.parse(content) : content
  const lines = text.lines()
  const type = noteType(path)
  const problems: Problem[] = []
  const { frontMatter, problems: fmProblems } = parseFrontMatter(lines)
  for (const p of fmProblems) problems.push({ path, line: p.line + 1, message: p.message })
  if (frontMatter) {
    for (const e of frontMatter.entries) {
      const message = frontMatterProblem(type, e.key, e.value)
      if (message) problems.push({ path, line: e.index + 1, message: `Front matter: ${message}.` })
    }
  }

  const headings: Heading[] = []
  const items: Item[] = []
  const seen = new Map<string, number>()
  const stack: Heading[] = []
  let fence: string | null = null
  let i = frontMatter ? frontMatter.end + 1 : 0
  for (; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1] === fence) fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      const fields: Field[] = []
      const title = h[2]!
        .replace(HEADING_FIELD, (_m, key: string, value: string) => {
          fields.push({ key, value })
          return ''
        })
        .trim()
      const heading = { index: i, level: h[1]!.length, title, fields }
      headings.push(heading)
      while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop()
      stack.push(heading)
      continue
    }
    const parsed = parseItemLine(line)
    if (!parsed) continue
    const quote: string[] = []
    while (i + 1 + quote.length < lines.length) {
      const q = QUOTE.exec(lines[i + 1 + quote.length]!)
      if (!q) break
      quote.push(q[1]!)
    }
    const occurrence = seen.get(line) ?? 0
    seen.set(line, occurrence + 1)
    items.push({
      id: itemId(path, line, occurrence),
      path,
      index: i,
      quoteCount: quote.length,
      raw: line,
      indent: parsed.indent,
      marker: parsed.marker,
      checked: parsed.checked,
      text: parsed.text,
      fields: parsed.fields,
      links: parsed.links,
      quote,
      section: stack.map((s) => s.title),
    })
    for (const message of parsed.problems) problems.push({ path, line: i + 1, message })
    for (const field of parsed.fields) {
      const message = fieldValueProblem(field.key, field.value)
      if (message) problems.push({ path, line: i + 1, message: `Field ${message}.` })
    }
    i += quote.length
  }
  if (fence) problems.push({ path, line: lines.length, message: "A code fence isn't closed." })
  problems.sort((a, b) => a.line - b.line)
  return { path, type, text, frontMatter, headings, items, problems }
}

export function serializeNote(note: Note): string {
  return note.text.toString()
}

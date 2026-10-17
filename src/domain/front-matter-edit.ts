import { renderFrontMatterEntry } from '../format/front-matter.ts'
import type { Note } from '../format/note.ts'

/** The line edit that sets (or with null, removes) one front matter key, touching only that line. */
export function setFrontMatterLines(
  note: Note,
  key: string,
  value: string | null,
): { start: number; count: number; lines: string[] } {
  const fm = note.frontMatter
  const line = value === null ? null : renderFrontMatterEntry(key, value)
  if (!fm) {
    return line === null
      ? { start: 0, count: 0, lines: [] }
      : { start: 0, count: 0, lines: ['---', line, '---'] }
  }
  const entry = fm.entries.find((e) => e.key === key)
  if (entry) {
    if (line !== null) return { start: entry.index, count: 1, lines: [line] }
    // Removing the last entry removes the whole block.
    const others = fm.entries.length - 1
    const nonEntry = note.text
      .lines()
      .slice(fm.start + 1, fm.end)
      .some((l, i) => fm.start + 1 + i !== entry.index && l.trim() !== '')
    if (others === 0 && !nonEntry)
      return { start: fm.start, count: fm.end - fm.start + 1, lines: [] }
    return { start: entry.index, count: 1, lines: [] }
  }
  if (line === null) return { start: 0, count: 0, lines: [] }
  return { start: fm.end, count: 0, lines: [line] }
}

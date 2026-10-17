// Front matter: a small subset of YAML. One `key: value` per line between `---` lines; values
// are plain text or double-quoted strings. Anything else is kept and reported.

export interface FrontMatterEntry {
  key: string
  value: string
  /** Index of the entry's line (0-based). */
  index: number
}

export interface FrontMatter {
  /** Index of the opening `---` (always 0). */
  start: number
  /** Index of the closing `---`. */
  end: number
  entries: FrontMatterEntry[]
}

export interface FrontMatterProblem {
  /** Index of the line (0-based). */
  line: number
  message: string
}

const ENTRY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/

export function parseFrontMatter(lines: readonly string[]): {
  frontMatter: FrontMatter | null
  problems: FrontMatterProblem[]
} {
  if (lines[0] !== '---') return { frontMatter: null, problems: [] }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i
      break
    }
  }
  if (end < 0) {
    return {
      frontMatter: null,
      problems: [{ line: 0, message: "Front matter isn't closed with a --- line." }],
    }
  }
  const entries: FrontMatterEntry[] = []
  const problems: FrontMatterProblem[] = []
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const m = ENTRY.exec(line)
    if (!m) {
      problems.push({ line: i, message: "Front matter lines should be 'key: value'." })
      continue
    }
    const parsed = parseValue(m[2] ?? '')
    if (parsed === null) {
      problems.push({ line: i, message: "This front matter value's quotes aren't closed." })
      continue
    }
    entries.push({ key: m[1]!, value: parsed, index: i })
  }
  return { frontMatter: { start: 0, end, entries }, problems }
}

function parseValue(raw: string): string | null {
  if (raw.startsWith('"')) {
    let out = ''
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i]!
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[++i]!
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n
      } else if (c === '"') {
        return out
      } else {
        out += c
      }
    }
    return null
  }
  if (raw.startsWith("'")) {
    const close = raw.lastIndexOf("'")
    if (close <= 0) return null
    return raw.slice(1, close).replace(/''/g, "'")
  }
  // A plain value ends at a " #" comment.
  const hash = raw.search(/[ \t]#/)
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim()
}

export function frontMatterValue(fm: FrontMatter | null, key: string): string | undefined {
  return fm?.entries.find((e) => e.key === key)?.value
}

/** Writes one entry line, quoting the value when plain YAML would read it differently. */
export function renderFrontMatterEntry(key: string, value: string): string {
  const plain =
    value !== '' &&
    !/^[[\]{}"'>|&*!%@`#,?:-]/.test(value) &&
    !/:(\s|$)/.test(value) &&
    !/\s#/.test(value) &&
    value.trim() === value
  if (plain) return `${key}: ${value}`
  return `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

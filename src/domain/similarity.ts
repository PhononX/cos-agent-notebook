// Text comparison without any model: normalization, edit distance and token overlap. Used for
// duplicate checks, matching items by phrase and checking names.

/** Lowercase words with links, fields, Markdown and accents taken out. */
export function normalize(s: string): string {
  return s
    .replace(/\[[a-z][a-z0-9_]*::[^\]]*\]/g, ' ')
    .replace(/\[\[([^\]|#]*)[^\]]*\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function tokens(s: string): string[] {
  const n = normalize(s)
  return n ? n.split(' ') : []
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = cur
  }
  return prev[b.length]!
}

/** 1 for identical strings, 0 for nothing in common, by edit distance. */
export function editSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max
}

/** Dice coefficient over word sets. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (!ta.size && !tb.size) return 1
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return (2 * common) / (ta.size + tb.size)
}

/** How alike two item texts are, 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  return Math.max(tokenSimilarity(na, nb), editSimilarity(na, nb) * 0.95)
}

/** Whether every word of `phrase` appears in `text`, as a run of words or in any order. */
export function phraseMatches(phrase: string, text: string): 'exact' | 'contains' | 'words' | null {
  const p = normalize(phrase)
  const t = normalize(text)
  if (!p) return null
  if (p === t) return 'exact'
  if (` ${t} `.includes(` ${p} `)) return 'contains'
  const words = new Set(t.split(' '))
  return p.split(' ').every((w) => words.has(w)) ? 'words' : null
}

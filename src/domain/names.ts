// Name checks: a name close to an existing person, project or area, but not the same, is
// probably a transcription error ("Dana Whitfeld"), so it's refused with the closest matches.

import { editSimilarity, normalize } from './similarity.ts'

export type NameType = 'person' | 'project' | 'area' | 'link'

export interface KnownName {
  name: string
  /** `link` for a name that is linked somewhere but has no note. */
  type: NameType
}

export interface NameMatch {
  name: string
  type: NameType
  score: number
}

export type NameCheck =
  | { status: 'existing'; name: string; type: NameType }
  | { status: 'new'; name: string }
  | { status: 'close'; name: string; matches: NameMatch[] }

const CLOSE = 0.8

export function scoreName(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  let score = editSimilarity(na, nb)
  // One name's words all appear in the other: "Dana" and "Dana Whitfield".
  const ta = na.split(' ')
  const tb = nb.split(' ')
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.every((t) => long.includes(t))) score = Math.max(score, 0.85)
  return Math.round(score * 100) / 100
}

/** The closest known names, best first. */
export function closestNames(name: string, known: readonly KnownName[], limit = 3): NameMatch[] {
  const best = new Map<string, NameMatch>()
  for (const k of known) {
    const score = scoreName(name, k.name)
    const prev = best.get(k.name)
    if (!prev || (prev.type === 'link' && k.type !== 'link')) {
      best.set(k.name, { name: k.name, type: k.type, score })
    }
  }
  return [...best.values()]
    .filter((m) => m.score > 0.5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

export function checkName(name: string, known: readonly KnownName[]): NameCheck {
  const target = normalize(name)
  // The same name, written differently (case, accents, spacing): use the existing spelling.
  const same = known.filter((k) => normalize(k.name) === target)
  const exact = same.find((k) => k.name === name) ?? same.find((k) => k.type !== 'link') ?? same[0]
  if (exact) return { status: 'existing', name: exact.name, type: exact.type }
  const matches = closestNames(name, known).filter((m) => m.score >= CLOSE)
  if (matches.length) return { status: 'close', name, matches }
  return { status: 'new', name }
}

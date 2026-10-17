// Value rules from the format: dates, times, names, field and front matter values.

export const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function isDate(s: string): boolean {
  const m = DATE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1) return false
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return d <= days
}

export function isTime(s: string): boolean {
  return TIME.test(s)
}

const NAME_FORBIDDEN = /[[\]|#^/\\:*?"<>]/

/** Why a note name isn't allowed, or null when it is. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'is empty'
  if (name !== name.trim()) return 'has spaces at the start or end'
  if (/[\r\n\t]/.test(name)) return 'must be one line'
  if (name.length > 100) return 'is longer than 100 characters'
  if (name.startsWith('.')) return "can't start with a dot"
  const bad = NAME_FORBIDDEN.exec(name)
  if (bad) return `can't contain "${bad[0]}"`
  return null
}

export const KEY = /^[a-z][a-z0-9_]*$/

const SRC = /^([a-z][a-z0-9_-]*)(?: (\d{4}-\d{2}-\d{2}))?(?: (\S+))?$/

export interface Src {
  source: string
  date?: string
  link?: string
}

export function parseSrc(value: string): Src | null {
  const m = SRC.exec(value)
  if (!m) return null
  if (m[2] && !isDate(m[2])) return null
  if (m[3] && !/^https?:\/\/\S+$/.test(m[3])) return null
  return { source: m[1]!, ...(m[2] ? { date: m[2] } : {}), ...(m[3] ? { link: m[3] } : {}) }
}

export function renderSrc(src: Src): string {
  return [src.source, src.date, src.link].filter(Boolean).join(' ')
}

const DATE_FIELDS = new Set(['due', 'since', 'nudged', 'superseded', 'done', 'archived'])
const TIME_FIELDS = new Set(['sent', 'at'])

/** Why a field value doesn't fit the format, or null when it does (or the key is unknown). */
export function fieldValueProblem(key: string, value: string): string | null {
  if (DATE_FIELDS.has(key) && !isDate(value)) return `${key} should be a date, YYYY-MM-DD`
  if (TIME_FIELDS.has(key) && !isTime(value)) return `${key} should be a time, HH:MM`
  if (key === 'prep' && !/^(ready|offered)$/.test(value) && !isTime(value)) {
    return 'prep should be ready, offered or a time HH:MM'
  }
  if (key === 'raised' && !/^\d+$/.test(value)) return 'raised should be a whole number'
  if (key === 'kind' && value === '') return 'kind is empty'
  if (key === 'src' && !parseSrc(value)) {
    return 'src should be "<source> <YYYY-MM-DD>", then a link if there is one'
  }
  return null
}

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'dropped']
export const DRAFT_STATUSES = ['notes', 'outline', 'draft', 'ready', 'moved', 'done', 'dropped']

const FM_DATES = new Set(['date', 'due', 'last_talked', 'touched'])
const FM_COUNTS = new Set(['version', 'nudges_per_day', 'stale_days'])

/** Why a front matter value doesn't fit the format for this kind of note, or null. */
export function frontMatterProblem(noteType: string, key: string, value: string): string | null {
  if (FM_DATES.has(key) && !isDate(value)) return `${key} should be a date, YYYY-MM-DD`
  if (FM_COUNTS.has(key) && !/^\d+$/.test(value)) return `${key} should be a whole number`
  if (key === 'status' && noteType === 'project' && !PROJECT_STATUSES.includes(value)) {
    return `status should be one of ${PROJECT_STATUSES.join(', ')}`
  }
  if (key === 'status' && noteType === 'draft' && !DRAFT_STATUSES.includes(value)) {
    return `status should be one of ${DRAFT_STATUSES.join(', ')}`
  }
  if (key === 'horizon' && noteType === 'draft' && !['soon', 'long'].includes(value)) {
    return 'horizon should be soon or long'
  }
  if (key === 'meeting_prep' && !['offer', 'auto', 'off'].includes(value)) {
    return 'meeting_prep should be offer, auto or off'
  }
  if (key === 'same_as' && noteType !== 'person') return 'same_as is only for person notes'
  if (key === 'same_as' && !parseSameAs(value)) {
    return 'same_as should be links like "workspace:northwind:alex/Dana Whitfield", separated by " | "'
  }
  if (key === 'timezone' && !isTimeZone(value)) {
    return 'timezone should be an IANA time zone name, like Europe/Berlin'
  }
  return null
}

/**
 * A `same_as` link on a person note: the same person's note in another notebook, written
 * `<notebook>/<note name>`, like `workspace:northwind:alex/Dana Whitfield`. Several are
 * separated by ` | ` (names can't contain `|`).
 */
export interface SameAs {
  notebook: string
  name: string
}

const NOTEBOOK_NAME = /^(?:personal|workspace):[a-z0-9][a-z0-9_-]{0,62}:[a-z0-9][a-z0-9_-]{0,62}$/

export function parseSameAs(value: string): SameAs[] | null {
  const out: SameAs[] = []
  for (const part of value.split('|')) {
    const link = part.trim()
    const slash = link.indexOf('/')
    if (slash < 0) return null
    const notebook = link.slice(0, slash)
    const name = link.slice(slash + 1)
    if (!NOTEBOOK_NAME.test(notebook) || nameProblem(name)) return null
    out.push({ notebook, name })
  }
  return out
}

export function renderSameAs(links: readonly SameAs[]): string {
  return links.map((l) => `${l.notebook}/${l.name}`).join(' | ')
}

export function isTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

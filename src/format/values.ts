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
  if (key === 'workspace_ids') {
    if (noteType !== 'my-rules') return 'workspace_ids is only for my-rules.md'
    const { invalid } = parseWorkspaceIds(value)
    if (invalid.length) {
      return `workspace_ids has a part that isn't "<source>:<id>" ("${invalid[0]}"), like "slack:T024BE7LD", separated by " | "`
    }
  }
  if (key === 'same_as' && noteType !== 'person') return 'same_as is only for person notes'
  if (key === 'same_as') {
    const { links, invalid } = parseSameAs(value)
    if (invalid.length) {
      return `same_as has ${invalid.length > 1 ? "parts that aren't links" : "a part that isn't a link"} to a note in a work notebook ("${invalid[0]}"); links look like "workspace:northwind:alex/Dana Whitfield", separated by " | "`
    }
    if (links.length > SAME_AS_MAX_LINKS) return `same_as has more than ${SAME_AS_MAX_LINKS} links`
  }
  if (key === 'timezone' && !isTimeZone(value)) {
    return 'timezone should be an IANA time zone name, like Europe/Berlin'
  }
  return null
}

/**
 * An id a client uses for a workspace, like `slack:T024BE7LD` or `google:northwind.example`:
 * a short lowercase source, a colon, and the client's id (no spaces or `|`). A work notebook's
 * my-rules.md lists them in `workspace_ids`, so a client can name the workspace its own way.
 */
export interface WorkspaceId {
  source: string
  id: string
}

export const WORKSPACE_ID_SOURCE = /^[a-z][a-z0-9_-]{0,31}$/
export const WORKSPACE_ID_VALUE = /^[^\s|[\]"]{1,200}$/

export function parseWorkspaceIds(value: string): { ids: WorkspaceId[]; invalid: string[] } {
  const ids: WorkspaceId[] = []
  const invalid: string[] = []
  for (const part of value.split('|')) {
    const s = part.trim()
    const colon = s.indexOf(':')
    const source = colon < 0 ? '' : s.slice(0, colon)
    const id = colon < 0 ? '' : s.slice(colon + 1)
    if (WORKSPACE_ID_SOURCE.test(source) && WORKSPACE_ID_VALUE.test(id)) ids.push({ source, id })
    else invalid.push(s)
  }
  return { ids, invalid }
}

export function renderWorkspaceIds(ids: readonly WorkspaceId[]): string {
  return ids.map((i) => `${i.source}:${i.id}`).join(' | ')
}

/** One part of a notebook's name (an account, workspace or notebook id). */
export const ID_PART = '[a-z0-9][a-z0-9_-]{0,62}'

/** The name of a work notebook, like `workspace:northwind:alex`. */
export const WORK_NOTEBOOK = new RegExp(`^workspace:${ID_PART}:${ID_PART}$`)

/**
 * A `same_as` link on a person note in a personal notebook: the same person's note in a work
 * notebook, written `<notebook>/<note name>`, like `workspace:northwind:alex/Dana Whitfield`.
 * Several are separated by ` | ` (names can't contain `|`).
 */
export interface SameAs {
  notebook: string
  name: string
}

export const SAME_AS_MAX_LINKS = 20

/** Reads every link it can; parts that aren't links are returned as `invalid`, never dropped silently. */
export function parseSameAs(value: string): { links: SameAs[]; invalid: string[] } {
  const links: SameAs[] = []
  const invalid: string[] = []
  for (const part of value.split('|')) {
    const link = part.trim()
    const slash = link.indexOf('/')
    const notebook = slash < 0 ? '' : link.slice(0, slash)
    const name = slash < 0 ? '' : link.slice(slash + 1)
    if (WORK_NOTEBOOK.test(notebook) && !nameProblem(name)) links.push({ notebook, name })
    else invalid.push(link)
  }
  return { links, invalid }
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

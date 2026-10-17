// The notebook's layout: which files exist, what kind of note each path is, and where each kind
// of item lives.

import { nameProblem } from './values.ts'

export type NoteType =
  | 'now'
  | 'brief'
  | 'catch-up'
  | 'nudges'
  | 'inbox'
  | 'actions'
  | 'waiting'
  | 'ideas'
  | 'links'
  | 'facts'
  | 'decisions'
  | 'about-me'
  | 'my-rules'
  | 'sources'
  | 'person'
  | 'project'
  | 'area'
  | 'draft'
  | 'log'
  | 'archive'
  | 'other'

const TOP_FILES: Record<string, NoteType> = {
  'now.md': 'now',
  'brief.md': 'brief',
  'catch-up.md': 'catch-up',
  'nudges.md': 'nudges',
  'inbox.md': 'inbox',
  'actions.md': 'actions',
  'waiting.md': 'waiting',
  'ideas.md': 'ideas',
  'links.md': 'links',
  'facts.md': 'facts',
  'decisions.md': 'decisions',
  'about-me.md': 'about-me',
  'my-rules.md': 'my-rules',
  'sources.md': 'sources',
}

export const NAMED_FOLDERS = {
  person: 'people',
  project: 'projects',
  area: 'areas',
  draft: 'drafts',
} as const

export type NamedNoteType = keyof typeof NAMED_FOLDERS

export const LOG_PATH = /^log\/(\d{4}-\d{2}-\d{2})\.md$/
export const ARCHIVE_PATH = /^archive\/(\d{4}-\d{2})\.md$/

export function noteType(path: string): NoteType {
  const top = TOP_FILES[path]
  if (top) return top
  if (LOG_PATH.test(path)) return 'log'
  if (ARCHIVE_PATH.test(path)) return 'archive'
  const m = /^([^/]+)\/([^/]+)\.md$/.exec(path)
  if (m) {
    for (const [type, folder] of Object.entries(NAMED_FOLDERS)) {
      if (m[1] === folder) return type as NamedNoteType
    }
  }
  return 'other'
}

export function namedNotePath(type: NamedNoteType, name: string): string {
  return `${NAMED_FOLDERS[type]}/${name}.md`
}

/** The name of a person, project, area or draft note (`people/Dana Whitfield.md` → its name). */
export function noteName(path: string): string | null {
  const t = noteType(path)
  if (t === 'person' || t === 'project' || t === 'area' || t === 'draft') {
    return path.slice(path.indexOf('/') + 1, -3)
  }
  return null
}

/** Why a path isn't a notebook note path, or null when it is. */
export function pathProblem(path: string): string | null {
  if (typeof path !== 'string' || path === '') return 'is empty'
  if (path.includes('\0') || /[\r\n]/.test(path)) return 'has control characters'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
    return 'must be relative to the notebook, with / between folders'
  }
  if (!path.endsWith('.md')) return 'must end in .md'
  const parts = path.split('/')
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') return 'has an empty, "." or ".." part'
    if (p.startsWith('.')) return 'is inside a hidden folder or is a hidden file'
  }
  const name = noteName(path)
  if (name !== null) {
    const problem = nameProblem(name)
    if (problem) return `names a note whose name ${problem}`
  }
  return null
}

/** The note a link like `[[Dana Whitfield]]` resolves to, if one exists in `paths`. */
export function resolveLink(name: string, paths: Iterable<string>): string | null {
  for (const p of paths) if (noteName(p) === name) return p
  return null
}

export type ItemKind =
  'action' | 'waiting' | 'idea' | 'link' | 'fact' | 'decision' | 'inbox' | 'catch_up'

export const ITEM_KINDS: readonly ItemKind[] = [
  'action',
  'waiting',
  'idea',
  'link',
  'fact',
  'decision',
  'inbox',
  'catch_up',
]

export interface KindLayout {
  file: string
  /** The `##` section new items go under, if the file has sections. */
  section?: string
  checkbox: boolean
}

export const KIND_LAYOUT: Record<ItemKind, KindLayout> = {
  action: { file: 'actions.md', section: 'To do', checkbox: true },
  waiting: { file: 'waiting.md', checkbox: true },
  idea: { file: 'ideas.md', checkbox: false },
  link: { file: 'links.md', checkbox: false },
  fact: { file: 'facts.md', checkbox: false },
  decision: { file: 'decisions.md', checkbox: false },
  inbox: { file: 'inbox.md', checkbox: false },
  catch_up: { file: 'catch-up.md', checkbox: false },
}

export const CATCH_UP_SECTIONS: Record<string, string> = {
  reply: 'Needs your reply',
  missed: 'You may have missed',
  changed: 'Changed',
}

export function kindOfFile(path: string): ItemKind | null {
  for (const k of ITEM_KINDS) if (KIND_LAYOUT[k].file === path) return k
  return null
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export function archivePath(date: string): string {
  return `archive/${date.slice(0, 7)}.md`
}

export function logPath(date: string): string {
  return `log/${date}.md`
}

/** The lines a note starts with when the service creates it. */
export function newNoteLines(path: string, space: SpaceKind = 'personal'): string[] {
  const t = noteType(path)
  if (t === 'my-rules' && space === 'workspace') return [...WORK_RULES_TEMPLATE]
  const m = ARCHIVE_PATH.exec(path)
  if (m) {
    const [y, mo] = m[1]!.split('-')
    return [`# Archive: ${MONTHS[Number(mo) - 1]} ${y}`]
  }
  const log = LOG_PATH.exec(path)
  if (log) return [`# ${log[1]}`]
  const name = noteName(path)
  if (name !== null) return [`# ${name}`]
  const template = NOTE_TEMPLATES[t]
  if (template) return [...template]
  return [`# ${path.split('/').pop()!.slice(0, -3)}`]
}

const NOTE_TEMPLATES: Partial<Record<NoteType, readonly string[]>> = {
  now: ['# Now', '', '## Focus', '', '## This week', '', '## Suggested moves'],
  'catch-up': [
    '# Catch up',
    '',
    '## Needs your reply',
    '',
    '## You may have missed',
    '',
    '## Changed',
  ],
  nudges: ['# Nudges'],
  inbox: ['# Inbox', '', 'Captured, not yet sorted.'],
  actions: ['# My actions', '', '## To do', '', '## Elsewhere'],
  waiting: ['# Waiting on others'],
  ideas: ['# Come back to'],
  links: ['# Links'],
  facts: ['# Facts'],
  decisions: ['# Decisions'],
  'about-me': [
    '# About me',
    '',
    '## Role',
    '',
    '## How I work',
    '',
    '## How I write',
    '',
    '## Learned',
  ],
  'my-rules': [
    '# My rules',
    '',
    '## My rules',
    '',
    '## Where things go',
    '',
    '## My briefs',
    '',
    '## What goes in my briefs',
    '',
    '## Important people',
    '',
    '## My tools',
  ],
  sources: ['# Where I talk'],
}

/** Which kind of space a notebook is in. Some files and settings belong to the person only. */
export type SpaceKind = 'personal' | 'workspace'

/** Files that describe the person and travel with them: only in the personal notebook. */
export const PERSONAL_ONLY_FILES: readonly string[] = ['about-me.md']

/** my-rules.md settings that are the person's preferences: only in the personal notebook. */
export const PERSONAL_ONLY_SETTINGS: readonly string[] = [
  'nudges_per_day',
  'stale_days',
  'meeting_prep',
  'brief_time',
  'brief_days',
]

/** my-rules.md sections that are the person's own: only in the personal notebook. */
export const PERSONAL_ONLY_SECTIONS: readonly string[] = ['My briefs']

/** A work notebook's my-rules.md holds only what is specific to that workspace. */
const WORK_RULES_TEMPLATE = [
  '# My rules for this workspace',
  '',
  '## Where things go',
  '',
  '## Important people',
  '',
  '## My tools',
]

/** The files a new notebook starts with, in order. */
export function starterFiles(space: SpaceKind): string[] {
  return STARTER_FILES.filter((f) => space === 'personal' || !PERSONAL_ONLY_FILES.includes(f))
}

/** The files a new personal notebook starts with, in order. */
export const STARTER_FILES = [
  'now.md',
  'catch-up.md',
  'nudges.md',
  'inbox.md',
  'actions.md',
  'waiting.md',
  'ideas.md',
  'links.md',
  'facts.md',
  'decisions.md',
  'about-me.md',
  'my-rules.md',
  'sources.md',
]

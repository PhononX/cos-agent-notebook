// The shape of an apply_changes call. Agents pass structured fields; the service writes the
// lines. Unknown keys are refused so a misspelled field never silently does nothing.

import { z } from 'zod'
import { NotebookError } from './errors.ts'

export const text = z.string()
export const names = z.union([z.string(), z.array(z.string()).min(1).max(10)])
export const date = z.string().describe('YYYY-MM-DD')
export const quote = z.union([z.string(), z.array(z.string()).max(20)])
const fieldValues = z.record(z.string(), z.union([z.string(), z.number()]))
const fieldChanges = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))

export const target = {
  id: z.string().optional().describe('The item id from a read'),
  match: z.string().optional().describe('A phrase from the item, when there is no id'),
  file: z.string().optional().describe('Limit `match` to one note, like actions.md'),
}

export const Target = z.strictObject(target)
export type Target = z.infer<typeof Target>

const kind = z.enum(['action', 'waiting', 'idea', 'link', 'fact', 'decision', 'inbox', 'catch_up'])

export const links = {
  person: names.optional(),
  project: z.string().optional(),
  area: z.string().optional(),
}

const AddOp = z.strictObject({
  op: z.literal('add'),
  kind,
  text,
  ...links,
  due: date.optional(),
  since: date.optional(),
  back: z.string().optional(),
  why: z.string().optional(),
  url: z.string().optional(),
  src: z.string().optional(),
  quote: quote.optional(),
  file: z.string().optional(),
  section: z.string().optional(),
  fields: fieldValues.optional(),
})

const CompleteOp = z.strictObject({ op: z.literal('complete'), ...target, date: date.optional() })

const UpdateOp = z.strictObject({
  op: z.literal('update'),
  ...target,
  text: text.optional(),
  ...links,
  done: z.boolean().optional(),
  fields: fieldChanges.optional(),
  quote: z.union([quote, z.null()]).optional(),
})

const ArchiveOp = z.strictObject({ op: z.literal('archive'), ...target, why: z.string() })

const MoveOp = z.strictObject({
  op: z.literal('move'),
  ...target,
  to_file: z.string().optional(),
  section: z.string().optional(),
  ...links,
})

const DecideOp = z.strictObject({
  op: z.literal('decide'),
  text,
  ...links,
  why: z.string().optional(),
  src: z.string().optional(),
  date: date.optional(),
  supersedes: Target.optional(),
})

export const Entry = z.union([
  z.string(),
  z.strictObject({ text, ...links, src: z.string().optional(), quote: quote.optional() }),
])
export type Entry = z.infer<typeof Entry>

const NoteOp = z.strictObject({
  op: z.literal('note'),
  type: z.enum(['person', 'project', 'area']).optional(),
  name: z.string().optional(),
  file: z.string().optional(),
  front_matter: fieldChanges.optional(),
  section: z.string().optional(),
  append: z.array(Entry).max(50).optional(),
  same_as: z
    .array(z.strictObject({ notebook: z.string(), name: z.string() }))
    .min(1)
    .max(10)
    .optional()
    .describe("Personal notebook only: the same person's note in a workspace notebook"),
})

const MergeOp = z.strictObject({
  op: z.literal('merge'),
  items: z.array(Target).min(2).max(20),
  text: text.optional(),
})

const PromoteOp = z.strictObject({
  op: z.literal('promote'),
  ...target,
  project: z.string(),
  front_matter: fieldChanges.optional(),
})

const SetFocusOp = z.strictObject({
  op: z.literal('set_focus'),
  focus: z.array(Entry).max(3).optional(),
  this_week: z
    .array(z.strictObject({ date, text, ...links }))
    .max(30)
    .optional(),
  suggest: Entry.optional(),
})

const RuleOp = z.strictObject({
  op: z.literal('rule'),
  ...target,
  section: z.string().optional(),
  text: text.optional(),
  replaces: z.string().optional(),
  fields: fieldValues.optional(),
  src: z.string().optional(),
  settings: fieldChanges.optional(),
})

const LogOp = z.strictObject({ op: z.literal('log'), text, ...links, src: z.string().optional() })

const IdentifyOp = z.strictObject({
  op: z.literal('identify'),
  source: z.string().describe("The client's kind of id, like slack, google or cv"),
  id: z.string().describe("The client's id for this workspace, like T024BE7LD"),
})

export const Operation = z.discriminatedUnion('op', [
  IdentifyOp,
  AddOp,
  CompleteOp,
  UpdateOp,
  ArchiveOp,
  MoveOp,
  DecideOp,
  NoteOp,
  MergeOp,
  PromoteOp,
  SetFocusOp,
  RuleOp,
  LogOp,
])
export type Operation = z.infer<typeof Operation>
export type OperationOf<K extends Operation['op']> = Extract<Operation, { op: K }>

export const ApplyChangesRequest = z.strictObject({
  operations: z.array(Operation).min(1).max(50),
  idempotency_key: z.string().min(8).max(200).optional(),
  dry_run: z.boolean().optional(),
  confirm_new_names: z.array(z.string()).max(20).optional(),
})
export type ApplyChangesRequest = z.infer<typeof ApplyChangesRequest>

export function parseRequest(input: unknown): ApplyChangesRequest {
  return parseInput(ApplyChangesRequest, input)
}

/** Parses a tool's input, or refuses it with the first problem and how to fix it. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]!
  const where = describePath(issue.path)
  throw new NotebookError('invalid_request', `${where ? `${where}: ` : ''}${issueMessage(issue)}`, {
    issues: parsed.error.issues
      .slice(0, 5)
      .map((i) => ({ path: i.path.join('.'), message: i.message })),
  })
}

function describePath(path: PropertyKey[]): string {
  if (path[0] === 'operations' && typeof path[1] === 'number') {
    const rest = path.slice(2).join('.')
    return `Operation ${path[1]}${rest ? ` (${rest})` : ''}`
  }
  return path.join('.')
}

function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return `unknown field ${issue.keys.map((k) => `"${k}"`).join(', ')}; check the field names in the tool description`
  }
  if (issue.code === 'invalid_union' && issue.path.at(-1) === 'op') {
    return 'unknown operation; use one of add, complete, update, archive, move, decide, note, merge, promote, set_focus, rule, log, identify'
  }
  return issue.message
}

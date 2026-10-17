// Which notebook a call is about. Every notebook lives in exactly one space: a person's own
// (personal) or a workspace's (work notebooks, one per member, controlled by the workspace).
// Spaces are stored apart, so each can have its own storage, keys, retention and deletion.

import { NotebookError } from './errors.ts'

export type Space = { kind: 'personal'; account: string } | { kind: 'workspace'; workspace: string }

export interface NotebookRef {
  space: Space
  /** The notebook within its space: `default` for a personal notebook, the member's account in a workspace. */
  id: string
}

const PART = /^[a-z0-9][a-z0-9_-]{0,62}$/

export function personalNotebook(account: string, id = 'default'): NotebookRef {
  return { space: { kind: 'personal', account }, id }
}

export function workspaceNotebook(workspace: string, id: string): NotebookRef {
  return { space: { kind: 'workspace', workspace }, id }
}

function spaceOwner(space: Space): string {
  return space.kind === 'personal' ? space.account : space.workspace
}

/** Checks a reference from outside: known space kind, and every part a safe lowercase id. */
export function checkRef(ref: unknown): NotebookRef {
  const r = ref as NotebookRef | null
  const kind = r?.space?.kind
  const owner =
    kind === 'personal'
      ? (r!.space as { account?: unknown }).account
      : kind === 'workspace'
        ? (r!.space as { workspace?: unknown }).workspace
        : undefined
  if (
    (kind !== 'personal' && kind !== 'workspace') ||
    typeof owner !== 'string' ||
    !PART.test(owner) ||
    typeof r?.id !== 'string' ||
    !PART.test(r.id)
  ) {
    throw new NotebookError(
      'invalid_request',
      'A notebook is named by its space (personal with an account, or workspace with a workspace id) and its id, each 1 to 63 lowercase letters, digits, - or _: like personal:alex:default or workspace:northwind:alex.',
    )
  }
  return r
}

/** The reference as one string: `personal:alex:default`, `workspace:northwind:alex`. */
export function formatRef(ref: NotebookRef): string {
  return `${ref.space.kind}:${spaceOwner(ref.space)}:${ref.id}`
}

export function parseRef(s: string): NotebookRef {
  const [kind, owner, id, ...rest] = s.split(':')
  if (rest.length || owner === undefined || id === undefined) return checkRef(null)
  return checkRef(
    kind === 'personal'
      ? personalNotebook(owner, id)
      : kind === 'workspace'
        ? workspaceNotebook(owner, id)
        : null,
  )
}

/**
 * A relative path that keeps spaces apart in storage: `personal/<account>/<id>` or
 * `workspaces/<workspace>/<id>`. Also the key for locks and other per-notebook state.
 */
export function notebookKey(ref: NotebookRef): string {
  const r = checkRef(ref)
  return r.space.kind === 'personal'
    ? `personal/${r.space.account}/${r.id}`
    : `workspaces/${r.space.workspace}/${r.id}`
}

export function sameNotebook(a: NotebookRef, b: NotebookRef): boolean {
  return notebookKey(a) === notebookKey(b)
}

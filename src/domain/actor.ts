// Who makes a change: a client (an agent, the dashboard, a sync engine), acting for a person.

import { NotebookError } from './errors.ts'
import type { Author } from './ports.ts'

export interface Actor {
  /** The client's name, like `claude-desktop` or `dashboard`. */
  client: string
  /** The person the client acts for. */
  person?: string
  /** The `src` used when an operation gives none, like `page` for the dashboard. */
  source?: string
  /** Scopes granted to the client; undefined means every scope (local mode). */
  scopes?: readonly string[]
}

const CLIENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SOURCE = /^[a-z][a-z0-9_-]{0,31}$/

export function checkActor(actor: Actor): Actor {
  if (!actor || typeof actor.client !== 'string' || !CLIENT.test(actor.client)) {
    throw new NotebookError(
      'invalid_request',
      'The client name must be 1 to 64 letters, digits, dots, dashes or underscores.',
    )
  }
  if (actor.person !== undefined && (!actor.person.trim() || /[[\]\r\n]/.test(actor.person))) {
    throw new NotebookError(
      'invalid_request',
      "The person's name must be one line, without brackets.",
    )
  }
  if (actor.source !== undefined && !SOURCE.test(actor.source)) {
    throw new NotebookError('invalid_request', 'The default source must be a short lowercase word.')
  }
  return actor
}

export function hasScope(actor: Actor, scope: string): boolean {
  return (
    actor.scopes === undefined || actor.scopes.includes(scope) || actor.scopes.includes('admin')
  )
}

/** How the actor appears in the daily log and in history: `claude-desktop for Alex`. */
export function actorLabel(actor: Actor): string {
  return actor.person ? `${actor.client} for ${actor.person}` : actor.client
}

export function actorAuthor(actor: Actor): Author {
  return {
    name: actorLabel(actor),
    email: `${actor.client.toLowerCase()}@clients.cos-notebook.invalid`,
  }
}

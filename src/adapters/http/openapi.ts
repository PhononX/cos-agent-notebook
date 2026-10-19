// The OpenAPI description of the HTTP API, built from the same schemas that check requests.

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ApplyChangesRequest } from '../../domain/request.ts'
import { StartSessionInput } from '../../domain/reads.ts'
import {
  ClearNudgesInput,
  SaveDraftInput,
  UpdateCatchUpInput,
  WriteBriefInput,
} from '../../domain/tool-operations.ts'

function schema(s: z.ZodType) {
  return z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' })
}

const notebook = {
  name: 'ref',
  in: 'path',
  required: true,
  description: 'The notebook, like personal:alex:default or workspace:northwind:alex',
  schema: { type: 'string' },
}

const q = (name: string, description: string, type = 'string') => ({
  name,
  in: 'query',
  required: false,
  description,
  schema: { type },
})

const ok = {
  '200': { description: 'The result, as JSON' },
  default: { description: 'A refusal: { error: { code, message, … } }' },
}

const body = (s: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: schema(s) } },
})

export function openApiDocument(): Record<string, unknown> {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string
  }
  const reads = [
    q('notebooks', 'Comma-separated notebooks to cover; all the token can read if left out'),
    q('limit', 'How many (default 50)', 'integer'),
    q('cursor', 'next_cursor from the previous page'),
  ]
  return {
    openapi: '3.1.0',
    info: {
      title: 'Chief of Staff notebook',
      version: pkg.version,
      description:
        'The notebook service. Every write names one notebook; reads cover every notebook the token can read, each result labelled with its notebook.',
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearer: [] }],
    paths: {
      '/healthz': { get: { summary: 'Liveness', security: [], responses: ok } },
      '/readyz': { get: { summary: 'Readiness', security: [], responses: ok } },
      '/v1/session': {
        post: {
          summary: 'start_session: everything an agent needs to begin',
          requestBody: body(StartSessionInput),
          responses: ok,
        },
      },
      '/v1/notebooks': { get: { summary: 'The notebooks this token can use', responses: ok } },
      '/v1/items': {
        get: {
          summary: 'get_items',
          parameters: [
            q(
              'kinds',
              'Comma-separated: action, waiting, idea, link, fact, decision, inbox, catch_up',
            ),
            q('file', 'Only items in this note'),
            q('person', ''),
            q('project', ''),
            q('area', ''),
            q('status', 'open (default), done or all'),
            q('due_before', 'YYYY-MM-DD'),
            q('due_after', 'YYYY-MM-DD'),
            q('untouched_days', 'Newest date on the line at least this many days old', 'integer'),
            ...reads,
          ],
          responses: ok,
        },
      },
      '/v1/search': {
        get: {
          summary: 'search',
          parameters: [
            q('q', 'The words to find'),
            q('kinds', ''),
            q('file', ''),
            q('person', ''),
            q('project', ''),
            ...reads,
          ],
          responses: ok,
        },
      },
      '/v1/names': {
        get: {
          summary: 'resolve_names',
          parameters: [q('name', 'A name to look up; repeat for several'), reads[0]],
          responses: ok,
        },
      },
      '/v1/review': {
        get: {
          summary: 'get_review_candidates',
          parameters: [
            q('kinds', 'overdue, stale, never_nudged, duplicate, recurring'),
            reads[0],
            reads[1],
          ],
          responses: ok,
        },
      },
      '/v1/changes': {
        get: {
          summary: 'get_changes: the change feed',
          parameters: [q('since', 'An ISO 8601 time or a change id'), ...reads],
          responses: ok,
        },
      },
      '/v1/profile': {
        get: {
          summary: 'The combined profile',
          parameters: [q('workspace', 'The work notebook being worked in')],
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/notes': {
        get: { summary: 'List the notes', parameters: [notebook], responses: ok },
      },
      '/v1/notebooks/{ref}/notes/{path}': {
        get: {
          summary: 'read_note',
          parameters: [
            notebook,
            { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
            q('sections', 'Comma-separated ## sections'),
          ],
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/changes': {
        post: {
          summary: 'apply_changes',
          parameters: [notebook],
          requestBody: body(ApplyChangesRequest),
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/undo': {
        post: {
          summary: 'undo',
          parameters: [notebook],
          requestBody: body(z.strictObject({ change_id: z.string() })),
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/brief': {
        post: {
          summary: 'write_brief',
          parameters: [notebook],
          requestBody: body(WriteBriefInput),
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/catch-up': {
        post: {
          summary: 'update_catch_up',
          parameters: [notebook],
          requestBody: body(UpdateCatchUpInput),
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/drafts': {
        post: {
          summary: 'save_draft',
          parameters: [notebook],
          requestBody: body(SaveDraftInput),
          responses: ok,
        },
      },
      '/v1/notebooks/{ref}/nudges/clear': {
        post: {
          summary: 'clear_nudges',
          parameters: [notebook],
          requestBody: body(ClearNudgesInput),
          responses: ok,
        },
      },
    },
  }
}

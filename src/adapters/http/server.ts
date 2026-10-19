// The HTTP API: JSON over HTTP, versioned under /v1. A thin adapter: it checks the request
// (host, origin, token, size, rate), turns it into a domain call, and turns the result or the
// refusal into a response. It has no notebook logic of its own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Actor } from '../../domain/actor.ts'
import { NotebookError, type ErrorCode } from '../../domain/errors.ts'
import { formatRef, parseRef, sameNotebook, type NotebookRef } from '../../domain/notebook-ref.ts'
import type { Logger } from '../../domain/ports.ts'
import type { NotebookService } from '../../domain/service.ts'
import type { AuthProvider, Principal } from './auth.ts'
import { openApiDocument } from './openapi.ts'

export interface HttpOptions {
  service: NotebookService
  auth: AuthProvider
  logger: Logger
  /**
   * Host names accepted in the Host header, and in the Origin header of browser requests, like
   * `127.0.0.1`, `localhost` or a Tailscale name. Any port. This blocks DNS rebinding.
   */
  allowedHosts: readonly string[]
  maxBodyBytes?: number
  /** Requests per second each token may make, with bursts of up to ten times that. */
  rateLimit?: number
  /** Handles /mcp (MCP over Streamable HTTP), after the same checks. */
  mcp?: (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    body: unknown,
  ) => Promise<void>
  /** Says whether the service can serve requests (for /readyz). */
  ready?: () => Promise<boolean>
}

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_value: 422,
  secret: 422,
  close_name: 422,
  ambiguous: 409,
  stale_id: 409,
  conflict: 409,
  idempotency_mismatch: 409,
  not_found: 404,
  not_a_notebook: 404,
  forbidden: 403,
  busy: 503,
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

interface Ctx {
  principal: Principal
  actor: Actor
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

type Handler = (ctx: Ctx) => Promise<unknown>

interface Route {
  method: 'GET' | 'POST'
  pattern: string
  regex: RegExp
  keys: string[]
  handler: Handler
}

function route(method: 'GET' | 'POST', pattern: string, handler: Handler): Route {
  const keys: string[] = []
  const source = pattern
    .split('/')
    .map((part) => {
      if (part === '*path') {
        keys.push('path')
        return '(.+)'
      }
      if (part.startsWith(':')) {
        keys.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { method, pattern, regex: new RegExp(`^${source}$`), keys, handler }
}

// ---------- query parameters into tool input ----------

const list = (q: URLSearchParams, key: string) => {
  const all = q.getAll(key).flatMap((v) => v.split(','))
  const trimmed = all.map((v) => v.trim()).filter(Boolean)
  return trimmed.length ? trimmed : undefined
}
const one = (q: URLSearchParams, key: string) => q.get(key) ?? undefined
const num = (q: URLSearchParams, key: string) => {
  const v = q.get(key)
  if (v === null) return undefined
  const n = Number(v)
  if (!Number.isInteger(n))
    throw new HttpError(400, 'invalid_request', `${key} must be a whole number.`)
  return n
}
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

function notebookParam(ctx: Ctx): NotebookRef {
  let ref: NotebookRef
  try {
    ref = parseRef(ctx.params.ref ?? '')
  } catch (e) {
    if (e instanceof NotebookError) throw e
    throw e
  }
  if (!ctx.principal.access.notebooks.some((n) => sameNotebook(n, ref))) {
    throw new NotebookError('forbidden', `This token can't use ${formatRef(ref)}.`)
  }
  return ref
}

function routes(service: NotebookService): Route[] {
  return [
    route('POST', '/v1/session', (c) =>
      service.startSession(c.principal.access, c.body ?? {}, c.actor),
    ),
    route('GET', '/v1/notebooks', async (c) => ({
      notebooks: c.principal.access.notebooks.map((n) => ({
        notebook: formatRef(n),
        space: n.space.kind,
      })),
    })),
    route('GET', '/v1/items', (c) =>
      service.getItems(
        c.principal.access,
        defined({
          notebooks: list(c.query, 'notebooks'),
          kinds: list(c.query, 'kinds'),
          file: one(c.query, 'file'),
          person: one(c.query, 'person'),
          project: one(c.query, 'project'),
          area: one(c.query, 'area'),
          status: one(c.query, 'status'),
          due_before: one(c.query, 'due_before'),
          due_after: one(c.query, 'due_after'),
          untouched_days: num(c.query, 'untouched_days'),
          limit: num(c.query, 'limit'),
          cursor: one(c.query, 'cursor'),
        }),
      ),
    ),
    route('GET', '/v1/search', (c) =>
      service.search(
        c.principal.access,
        defined({
          query: one(c.query, 'q') ?? '',
          notebooks: list(c.query, 'notebooks'),
          kinds: list(c.query, 'kinds'),
          file: one(c.query, 'file'),
          person: one(c.query, 'person'),
          project: one(c.query, 'project'),
          limit: num(c.query, 'limit'),
          cursor: one(c.query, 'cursor'),
        }),
      ),
    ),
    route('GET', '/v1/names', (c) =>
      service.resolveNames(
        c.principal.access,
        defined({ names: c.query.getAll('name'), notebooks: list(c.query, 'notebooks') }),
      ),
    ),
    route('GET', '/v1/review', (c) =>
      service.reviewCandidates(
        c.principal.access,
        defined({
          notebooks: list(c.query, 'notebooks'),
          kinds: list(c.query, 'kinds'),
          limit: num(c.query, 'limit'),
        }),
      ),
    ),
    route('GET', '/v1/changes', (c) =>
      service.getChanges(
        c.principal.access,
        defined({
          notebooks: list(c.query, 'notebooks'),
          since: one(c.query, 'since'),
          limit: num(c.query, 'limit'),
          cursor: one(c.query, 'cursor'),
        }),
      ),
    ),
    route('GET', '/v1/profile', async (c) => {
      const personal = c.principal.access.notebooks.find((n) => n.space.kind === 'personal')
      if (!personal)
        throw new NotebookError(
          'invalid_value',
          'This token has no personal notebook, so there is no profile.',
        )
      const work = c.principal.access.notebooks.filter((n) => n.space.kind === 'workspace')
      const current = one(c.query, 'workspace')
      const ref = current !== undefined ? work.find((w) => formatRef(w) === current) : undefined
      if (current !== undefined && !ref)
        throw new NotebookError(
          'invalid_value',
          `${current} isn't one of this token's work notebooks.`,
        )
      return service.profile(personal, { work, ...(ref ? { current: ref } : {}) })
    }),
    route('GET', '/v1/notebooks/:ref/notes', async (c) => ({
      notes: await service.listNotes(notebookParam(c)),
    })),
    route('GET', '/v1/notebooks/:ref/notes/*path', (c) => {
      const sections = list(c.query, 'sections')
      return service.readNote(notebookParam(c), c.params.path ?? '', sections ? { sections } : {})
    }),
    route('POST', '/v1/notebooks/:ref/changes', (c) =>
      service.applyChanges(notebookParam(c), c.body, c.actor),
    ),
    route('POST', '/v1/notebooks/:ref/undo', (c) => {
      const body = (c.body ?? {}) as { change_id?: unknown }
      if (typeof body.change_id !== 'string') {
        throw new NotebookError(
          'invalid_request',
          'Send { "change_id": "ch_…" }: the change to undo.',
        )
      }
      return service.undo(notebookParam(c), body.change_id, c.actor)
    }),
    route('POST', '/v1/notebooks/:ref/brief', (c) =>
      service.writeBrief(notebookParam(c), c.body, c.actor),
    ),
    route('POST', '/v1/notebooks/:ref/catch-up', (c) =>
      service.updateCatchUp(notebookParam(c), c.body, c.actor),
    ),
    route('POST', '/v1/notebooks/:ref/drafts', (c) =>
      service.saveDraft(notebookParam(c), c.body, c.actor),
    ),
    route('POST', '/v1/notebooks/:ref/nudges/clear', (c) =>
      service.clearNudges(notebookParam(c), c.body, c.actor),
    ),
  ]
}

// ---------- the server ----------

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...headers,
  })
  res.end(data)
}

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        // Answer 413 and close the connection, discarding the rest of the body.
        req.removeAllListeners('data')
        req.resume()
        reject(
          new HttpError(413, 'too_large', `The request body is larger than ${max} bytes.`, {
            Connection: 'close',
          }),
        )
      } else chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'invalid_request', 'The request body is not valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly rate: number
  private readonly burst: number

  constructor(rate: number) {
    this.rate = rate
    this.burst = rate * 10
  }

  take(key: string): boolean {
    const now = Date.now()
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate)
    b.at = now
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    this.buckets.set(key, b)
    return ok
  }
}

/** The host name in a Host header, without the port: `127.0.0.1:4747` → `127.0.0.1`, `[::1]:80` → `::1`. */
function hostName(host: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
  if (v6) return v6[1]!.toLowerCase()
  return host.replace(/:\d+$/, '').toLowerCase()
}

function originHost(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1']

const CLIENT_HEADER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SOURCE_HEADER = /^[a-z][a-z0-9_-]{0,31}$/

export function createHttpServer(opts: HttpOptions): Server {
  const table = routes(opts.service)
  const maxBody = opts.maxBodyBytes ?? 2 * 1024 * 1024
  const limiter = new RateLimiter(opts.rateLimit ?? 20)
  const openapi = openApiDocument()

  return createServer((req, res) => {
    const started = Date.now()
    let pattern = 'unknown'
    void (async () => {
      try {
        if (!opts.allowedHosts.includes(hostName(String(req.headers.host ?? '')))) {
          throw new HttpError(
            403,
            'forbidden_host',
            'This host name is not allowed. Add it to COS_NOTEBOOK_ALLOWED_HOSTS.',
          )
        }
        const origin = req.headers.origin
        if (origin !== undefined && !opts.allowedHosts.includes(originHost(origin))) {
          throw new HttpError(403, 'forbidden_origin', 'Requests from this origin are not allowed.')
        }
        const url = new URL(req.url ?? '/', 'http://local')
        if (req.method === 'GET' && url.pathname === '/healthz') {
          pattern = '/healthz'
          return send(res, 200, { ok: true })
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
          pattern = '/readyz'
          const ready = opts.ready ? await opts.ready() : true
          return send(res, ready ? 200 : 503, { ready })
        }
        if (req.method === 'GET' && url.pathname === '/v1/openapi.json') {
          pattern = '/v1/openapi.json'
          return send(res, 200, openapi)
        }

        const principal = await opts.auth.authenticate(req.headers.authorization)
        if (!principal) {
          throw new HttpError(
            401,
            'unauthorized',
            'Send the notebook token as "Authorization: Bearer <token>".',
            {
              'WWW-Authenticate': 'Bearer',
            },
          )
        }
        if (!limiter.take(String(req.headers.authorization))) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many requests; slow down and try again shortly.',
            { 'Retry-After': '1' },
          )
        }
        if (req.method === 'POST') {
          const type = String(req.headers['content-type'] ?? '')
          if (!type.startsWith('application/json')) {
            throw new HttpError(
              415,
              'unsupported_media_type',
              'Send the body as JSON, with Content-Type: application/json.',
            )
          }
        }
        const body = req.method === 'POST' ? await readBody(req, maxBody) : undefined

        if (url.pathname === '/mcp' && opts.mcp) {
          pattern = '/mcp'
          return await opts.mcp(req, res, principal, body)
        }

        const match = table
          .filter((r) => r.method === req.method)
          .map((r) => ({ r, m: r.regex.exec(url.pathname) }))
          .find((x) => x.m)
        if (!match) throw new HttpError(404, 'not_found', 'No such route. See /v1/openapi.json.')
        pattern = match.r.pattern
        const params: Record<string, string> = {}
        match.r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(match.m![i + 1]!)
        })
        const clientHeader = req.headers['x-cos-client']
        const sourceHeader = req.headers['x-cos-source']
        const client =
          typeof clientHeader === 'string' && CLIENT_HEADER.test(clientHeader)
            ? clientHeader
            : 'http'
        const source =
          typeof sourceHeader === 'string' && SOURCE_HEADER.test(sourceHeader)
            ? sourceHeader
            : undefined
        const actor: Actor = {
          client,
          ...(principal.person ? { person: principal.person } : {}),
          ...(source ? { source } : {}),
          ...(principal.scopes ? { scopes: principal.scopes } : {}),
        }
        const result = await match.r.handler({
          principal,
          actor,
          params,
          query: url.searchParams,
          body,
        })
        send(res, 200, result)
      } catch (e) {
        if (e instanceof HttpError) {
          send(res, e.status, { error: { code: e.code, message: e.message } }, e.headers)
        } else if (e instanceof NotebookError) {
          send(
            res,
            STATUS[e.code] ?? 400,
            { error: e.toJSON() },
            e.code === 'busy' ? { 'Retry-After': '1' } : {},
          )
        } else {
          opts.logger.error('http_failed', {
            route: pattern,
            error: e instanceof Error ? e.name : 'unknown',
          })
          send(res, 500, {
            error: {
              code: 'internal',
              message:
                'Something went wrong on the server. Nothing was changed by a call that failed this way; try again.',
            },
          })
        }
      } finally {
        // Routes, not paths: a note's path can carry a person's name.
        opts.logger.info('http', {
          method: req.method,
          route: pattern,
          status: res.statusCode,
          ms: Date.now() - started,
        })
      }
    })()
  })
}

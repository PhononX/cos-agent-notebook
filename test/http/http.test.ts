import assert from 'node:assert/strict'
import { request } from 'node:http'
import { describe, it } from 'node:test'
import { TOKEN, httpFixture } from '../helpers/http.ts'
import { TODAY } from '../helpers/service.ts'

/** A raw request, for headers fetch won't let us set (Host). */
function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

const NB = encodeURIComponent('personal:alex:default')

describe('HTTP API', () => {
  it('answers health and readiness without a token, and refuses everything else without one', async () => {
    const { base, call } = await httpFixture()
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
    assert.equal((await fetch(`${base}/readyz`)).status, 200)
    const res = await fetch(`${base}/v1/items`)
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('www-authenticate'), 'Bearer')
    assert.equal(
      (await call('GET', '/v1/items', undefined, { authorization: 'Bearer wrong' })).status,
      401,
    )
  })

  it('checks the Host and Origin headers against the allowed host names', async () => {
    const { port } = await httpFixture()
    const auth = { authorization: `Bearer ${TOKEN}` }
    assert.equal(await raw(port, '/v1/notebooks', { ...auth, host: `localhost:${port}` }), 200)
    assert.equal(await raw(port, '/v1/notebooks', { ...auth, host: 'evil.example.com' }), 403)
    assert.equal(await raw(port, '/healthz', { host: 'evil.example.com' }), 403)
    assert.equal(
      await raw(port, '/v1/notebooks', {
        ...auth,
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.example.com',
      }),
      403,
    )
    assert.equal(
      await raw(port, '/v1/notebooks', {
        ...auth,
        host: `127.0.0.1:${port}`,
        origin: `http://localhost:${port}`,
      }),
      200,
    )
  })

  it('applies changes, with the client and source from headers, and reads them back', async () => {
    const { call, history } = await httpFixture()
    const r = await call(
      'POST',
      `/v1/notebooks/${NB}/changes`,
      { operations: [{ op: 'add', kind: 'action', text: 'Book the offsite venue for March' }] },
      { 'x-cos-client': 'dashboard', 'x-cos-source': 'page' },
    )
    assert.equal(r.status, 200)
    assert.match(String(r.json.change_id), /^ch_/)
    const line = (r.json.results as { items: { line: string }[] }[])[0]!.items[0]!.line
    assert.equal(line, `- [ ] Book the offsite venue for March [src:: page ${TODAY}]`)
    assert.equal(
      history.commitsOf((await import('../helpers/service.ts')).NB).at(-1)!.author.name,
      'dashboard for Alex',
    )

    const items = await call('GET', '/v1/items?kinds=action&limit=100')
    assert.ok(
      (items.json.items as { text: string }[]).some(
        (i) => i.text === 'Book the offsite venue for March',
      ),
    )
    const note = await call('GET', `/v1/notebooks/${NB}/notes/people/Dana%20Whitfield.md`)
    assert.equal(note.json.path, 'people/Dana Whitfield.md')
    const sections = await call('GET', `/v1/notebooks/${NB}/notes/actions.md?sections=Elsewhere`)
    assert.match(String(sections.json.text), /^## Elsewhere/)
  })

  it('serves every read: session, search, names, review, changes, profile, notes', async () => {
    const { call } = await httpFixture()
    assert.equal((await call('POST', '/v1/session', {})).json.today !== undefined, true)
    assert.ok(
      ((await call('GET', '/v1/search?q=pricing%20deck')).json.items as unknown[]).length > 0,
    )
    const names = await call('GET', '/v1/names?name=Dana%20Whitfeld&name=Theo')
    assert.equal((names.json.names as unknown[]).length, 2)
    assert.equal((await call('GET', '/v1/review?kinds=overdue')).status, 200)
    assert.equal((await call('GET', '/v1/changes')).status, 200)
    assert.equal((await call('GET', '/v1/profile')).status, 200)
    const notes = await call('GET', `/v1/notebooks/${NB}/notes`)
    assert.ok((notes.json.notes as { path: string }[]).some((n) => n.path === 'actions.md'))
    assert.equal((await call('GET', '/v1/notebooks')).json.notebooks instanceof Array, true)
  })

  it('serves the write tools and undo', async () => {
    const { call } = await httpFixture()
    const brief = await call('POST', `/v1/notebooks/${NB}/brief`, {
      name: 'Morning brief',
      sections: [{ title: 'Focus', lines: ['A'] }],
    })
    assert.equal(brief.status, 200)
    const undone = await call('POST', `/v1/notebooks/${NB}/undo`, {
      change_id: brief.json.change_id,
    })
    assert.equal(undone.json.undone, brief.json.change_id)
    assert.equal(
      (await call('POST', `/v1/notebooks/${NB}/nudges/clear`, { all: true })).status,
      200,
    )
    assert.equal(
      (
        await call('POST', `/v1/notebooks/${NB}/catch-up`, {
          close: [{ match: 'seat counts', why: 'replied' }],
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await call('POST', `/v1/notebooks/${NB}/drafts`, {
          name: 'Note to Sam',
          draft: 'Hi Sam',
          change: 'first',
        })
      ).status,
      200,
    )
  })

  it('maps refusals to statuses with the error body', async () => {
    const { call } = await httpFixture()
    const close = await call('POST', `/v1/notebooks/${NB}/changes`, {
      operations: [{ op: 'add', kind: 'action', text: 'x', person: 'Dana Whitfeld' }],
    })
    assert.equal(close.status, 422)
    assert.equal((close.json.error as { code: string }).code, 'close_name')
    assert.equal(
      (await call('POST', `/v1/notebooks/${NB}/changes`, { operations: [] })).status,
      400,
    )
    assert.equal(
      (
        await call('POST', `/v1/notebooks/${NB}/changes`, {
          operations: [{ op: 'complete', match: 'send' }],
        })
      ).status,
      409,
    )
    const other = encodeURIComponent('workspace:northwind:alex')
    assert.equal(
      (
        await call('POST', `/v1/notebooks/${other}/changes`, {
          operations: [{ op: 'log', text: 'x' }],
        })
      ).status,
      403,
    )
    assert.equal((await call('GET', '/v1/nowhere')).status, 404)
  })

  it('requires JSON for writes, and limits the body size', async () => {
    const { base, call } = await httpFixture({ maxBodyBytes: 1000 })
    const res = await fetch(`${base}/v1/notebooks/${NB}/changes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(res.status, 415)
    const big = await call('POST', `/v1/notebooks/${NB}/changes`, {
      operations: [{ op: 'log', text: 'x'.repeat(2000) }],
    })
    assert.equal(big.status, 413)
    const bad = await fetch(`${base}/v1/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400)
  })

  it('rate-limits each token', async () => {
    const { call } = await httpFixture({ rateLimit: 1 })
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await call('GET', '/v1/notebooks')).status)
    assert.ok(statuses.includes(429))
  })

  it('publishes an OpenAPI description', async () => {
    const { base } = await httpFixture()
    const doc = (await (await fetch(`${base}/v1/openapi.json`)).json()) as {
      openapi: string
      paths: Record<string, unknown>
    }
    assert.equal(doc.openapi, '3.1.0')
    assert.ok(doc.paths['/v1/notebooks/{ref}/changes'])
  })

  it('logs routes, never note paths or content', async () => {
    const { call, logger } = await httpFixture()
    await call('GET', `/v1/notebooks/${NB}/notes/people/Dana%20Whitfield.md`)
    await call('POST', `/v1/notebooks/${NB}/changes`, {
      operations: [{ op: 'add', kind: 'fact', text: 'Wombat-canary-5521' }],
    })
    assert.ok(logger.lines.some((l) => l.includes('/v1/notebooks/:ref/notes/*path')))
    for (const l of logger.lines) {
      assert.ok(!l.includes('Dana') && !l.includes('Wombat'), l)
    }
  })
})

describe('local token file', () => {
  it('is created once with mode 0600 and reused', async () => {
    const { ensureTokenFile } = await import('../../src/adapters/http/auth.ts')
    const { tempDir } = await import('../helpers/tmp.ts')
    const { stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const path = join(await tempDir(), '.cos-notebook', 'token')
    const first = await ensureTokenFile(path)
    assert.ok(first.length >= 32)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(await ensureTokenFile(path), first)
  })
})

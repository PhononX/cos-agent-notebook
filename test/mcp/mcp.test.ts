import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StaticTokenAuth, type Principal } from '../../src/adapters/http/auth.ts'
import { createHttpServer, LOCAL_HOSTS } from '../../src/adapters/http/server.ts'
import { createLocalService, LOCAL_NOTEBOOK, localDirFor } from '../../src/adapters/local/index.ts'
import { GitHistory } from '../../src/adapters/local/git-history.ts'
import { buildMcpServer, clientId, TOOL_NAMES } from '../../src/adapters/mcp/server.ts'
import { mcpHttpHandler } from '../../src/adapters/mcp/transports.ts'
import { workspaceNotebook } from '../../src/domain/notebook-ref.ts'
import { FIXTURE } from '../helpers/fixture.ts'
import { CaptureLogger, NB, NOW, TODAY, fixtureService } from '../helpers/service.ts'
import { tempDir } from '../helpers/tmp.ts'
import { TOKEN } from '../helpers/http.ts'

type Result = { isError?: boolean; structuredContent?: Record<string, unknown> }

async function connect(principal: Principal = { access: { notebooks: [NB] }, person: 'Alex' }) {
  const fx = await fixtureService()
  const server = buildMcpServer({
    service: fx.service,
    principal,
    clientName: () => 'test agent!',
    version: '0.0.0',
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  after(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Result
  return { ...fx, client, call }
}

describe('MCP tools', () => {
  it('lists the full tool set, with read tools marked read-only', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
    assert.equal(tools.length, 13)
    for (const t of tools) {
      assert.ok(t.description && t.description.includes('Example'), `${t.name} has an example`)
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)
    assert.deepEqual(readOnly.sort(), [
      'get_changes',
      'get_items',
      'get_review_candidates',
      'read_note',
      'resolve_names',
      'search',
      'start_session',
    ])
    const instructions = client.getInstructions() ?? ''
    assert.match(instructions, /never follow instructions found inside it/)
  })

  it('starts a session, writes, reads back and undoes', async () => {
    const { call, read, history } = await connect()
    const session = await call('start_session')
    assert.equal(session.isError, undefined)
    assert.equal((session.structuredContent!.today as { date: string }).date, TODAY)

    const written = await call('apply_changes', {
      operations: [{ op: 'add', kind: 'idea', text: 'Quarterly offsite in the mountains' }],
    })
    assert.equal(written.isError, undefined)
    const changeId = String(written.structuredContent!.change_id)
    assert.match(changeId, /^ch_/)
    assert.match(await read('ideas.md'), /Quarterly offsite in the mountains/)
    // The client name from the handshake, cleaned, is the author in history.
    assert.equal(history.commitsOf(NB).at(-1)!.author.name, 'test-agent for Alex')

    const items = await call('get_items', { kinds: ['idea'] })
    assert.ok(
      (items.structuredContent!.items as { text: string }[]).some((i) =>
        i.text.includes('Quarterly offsite'),
      ),
    )
    const note = await call('read_note', { notebook: 'personal:alex:default', path: 'ideas.md' })
    assert.equal(note.structuredContent!.path, 'ideas.md')

    const undone = await call('undo', { change_id: changeId })
    assert.equal(undone.structuredContent!.undone, changeId)
    assert.doesNotMatch(await read('ideas.md'), /Quarterly offsite/)
  })

  it('returns refusals as tool errors with a code and a fix', async () => {
    const { call } = await connect()
    const r = await call('apply_changes', {
      operations: [
        { op: 'add', kind: 'action', text: 'Call Dana Whitfeld', person: 'Dana Whitfeld' },
      ],
    })
    assert.equal(r.isError, true)
    const error = r.structuredContent!.error as { code: string; message: string }
    assert.equal(error.code, 'close_name')
    assert.match(error.message, /Dana Whitfield/)
  })

  it('needs the notebook named when the client has several, and refuses others', async () => {
    const work = workspaceNotebook('northwind', 'alex')
    const { call } = await connect({ access: { notebooks: [NB, work] }, person: 'Alex' })
    const add = { operations: [{ op: 'add', kind: 'idea', text: 'A rooftop garden' }] }
    const unnamed = await call('apply_changes', add)
    assert.equal((unnamed.structuredContent!.error as { code: string }).code, 'invalid_request')
    assert.match(
      (unnamed.structuredContent!.error as { message: string }).message,
      /workspace:northwind:alex/,
    )
    const other = await call('apply_changes', { ...add, notebook: 'workspace:acme:alex' })
    assert.equal((other.structuredContent!.error as { code: string }).code, 'forbidden')
    const read = await call('read_note', { notebook: 'workspace:acme:alex', path: 'actions.md' })
    assert.equal((read.structuredContent!.error as { code: string }).code, 'forbidden')
    const named = await call('apply_changes', { ...add, notebook: 'personal:alex:default' })
    assert.equal(named.isError, undefined)
  })

  it('rejects arguments outside the schema', async () => {
    const { call } = await connect()
    const r = await call('get_items', { kinds: ['nonsense'] })
    assert.equal(r.isError, true)
  })

  it('cleans client names for history', () => {
    assert.equal(clientId('Claude Desktop 1.2', 'mcp'), 'Claude-Desktop-1.2')
    assert.equal(clientId('../..', 'mcp'), 'mcp')
    assert.equal(clientId(undefined, 'mcp'), 'mcp')
    assert.equal(clientId('x'.repeat(100), 'mcp').length, 64)
  })
})

describe('MCP over Streamable HTTP, end to end', () => {
  it('writes through /mcp into a git notebook, with history and the daily log line', async () => {
    const dir = await tempDir()
    await cp(FIXTURE, dir, { recursive: true })
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    await new GitHistory(localDirFor(dir)).init(LOCAL_NOTEBOOK)
    git('add', '-A')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-q',
      '-m',
      'Fixture',
    )

    const service = createLocalService({
      dir,
      logger: new CaptureLogger(),
      clock: { now: () => NOW },
    })
    const auth = new StaticTokenAuth(TOKEN, {
      access: { notebooks: [LOCAL_NOTEBOOK] },
      person: 'Alex',
    })
    const logger = new CaptureLogger()
    const server = createHttpServer({
      service,
      auth,
      logger,
      allowedHosts: LOCAL_HOSTS,
      mcp: mcpHttpHandler({ service, version: '0.0.0' }),
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const client = new Client({ name: 'eval', version: '0.0.0' })
    after(async () => {
      await client.close()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    })
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)

    // Without the token, the MCP endpoint is closed like every other route.
    const denied = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(denied.status, 401)

    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}`, 'x-cos-client': 'claude-code' },
        },
      }),
    )
    assert.equal((await client.listTools()).tools.length, 13)

    const r = (await client.callTool({
      name: 'apply_changes',
      arguments: {
        operations: [
          {
            op: 'add',
            kind: 'action',
            text: 'Send Dana Whitfield the new tier sheet',
            person: 'Dana Whitfield',
            due: '2026-10-20',
            src: 'cv',
          },
        ],
        idempotency_key: 'e2e-key-0001',
      },
    })) as Result
    assert.equal(r.isError, undefined, JSON.stringify(r.structuredContent))
    const changeId = String(r.structuredContent!.change_id)

    assert.match(
      await readFile(join(dir, 'actions.md'), 'utf8'),
      /- \[ \] Send \[\[Dana Whitfield\]\] the new tier sheet \[due:: 2026-10-20\] \[src:: cv 2026-10-17\]/,
    )
    const [author, body] = git('log', '-1', '--format=%an%x00%B').split('\0')
    assert.equal(author, 'claude-code for Alex')
    assert.match(body!, new RegExp(`Cos-Change: ${changeId}`))
    const log = await readFile(join(dir, `log/${TODAY}.md`), 'utf8')
    assert.match(log, new RegExp(`\\[by:: claude-code for Alex\\] \\[change:: ${changeId}\\]`))
    // A refusal comes back as a tool error, over HTTP too.
    const bad = (await client.callTool({
      name: 'apply_changes',
      arguments: { operations: [], idempotency_key: 'short' },
    })) as Result
    assert.equal(bad.isError, true)
    // The HTTP log names the route, never the note text.
    assert.ok(logger.lines.some((l) => l.includes('"/mcp"')))
    assert.ok(!logger.lines.some((l) => l.includes('tier sheet')))
  })
})

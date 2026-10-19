import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tempDir } from '../helpers/tmp.ts'

const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('cos-notebook', () => {
  it('prints help and the version', () => {
    assert.match(run(['--help']).stdout, /cos-notebook init/)
    assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+\n$/)
  })

  it('init starts a notebook in the given folder', async () => {
    const dir = join(await tempDir(), 'nb')
    const r = run(['init', dir, '--timezone', 'Asia/Tokyo'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Started a notebook in .*nb \(14 files, change ch_[0-9a-z]{8}\)\.\n$/)
    assert.match(readFileSync(join(dir, 'my-rules.md'), 'utf8'), /timezone: Asia\/Tokyo/)
    assert.ok(existsSync(join(dir, '.git')))
    const again = run(['init', dir])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already has notes/)
  })

  it('init uses COS_NOTEBOOK_DIR and COS_NOTEBOOK_TIMEZONE', async () => {
    const dir = join(await tempDir(), 'from-env')
    const r = run(['init'], { COS_NOTEBOOK_DIR: dir, COS_NOTEBOOK_TIMEZONE: 'Europe/Paris' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(join(dir, 'my-rules.md'), 'utf8'), /timezone: Europe\/Paris/)
  })

  it('explains bad input and commands that come later', () => {
    assert.equal(run(['init', '/tmp/x', '--timezone', 'Nowhere/Land']).status, 1)
    assert.equal(run(['bogus']).status, 2)
    const later = run(['sync'])
    assert.equal(later.status, 2)
    assert.match(later.stderr, /milestone 5/)
  })
})

describe('cos-notebook adopt', () => {
  it('adopts a folder and reports what it found', async () => {
    const dir = await tempDir()
    writeFileSync(join(dir, 'inbox.md'), '# Inbox\n\n- [src:: cv 2026-10-14] Fields first\n')
    const r = run(['adopt', dir, '--timezone', 'UTC'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^Adopted .*: 1 notes, time zone UTC \(change ch_[0-9a-z]{8}\)\.\n/)
    assert.match(r.stdout, /Added missing files: now\.md/)
    assert.match(
      r.stdout,
      /1 lines don't fit the format; they were left as they are:\n  inbox\.md:3 Fields should come after the sentence\./,
    )
    assert.equal(run(['adopt', dir]).status, 1)
    const init = run(['init', join(dir)])
    assert.match(init.stderr, /adopt the folder/)
  })
})

async function notebook(): Promise<string> {
  const dir = join(await tempDir(), 'nb')
  assert.equal(run(['init', dir, '--timezone', 'UTC']).status, 0)
  return dir
}

const git = (dir: string, ...args: string[]) =>
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout

describe('cos-notebook serve', () => {
  it('serves the HTTP API and MCP with the local token, and stops on SIGTERM', async () => {
    const dir = await notebook()
    const child = spawn(process.execPath, [MAIN, 'serve', dir, '--port', '0'], {
      env: { ...process.env, COS_NOTEBOOK_PERSON: 'Alex', COS_NOTEBOOK_LOG_LEVEL: 'warn' },
    })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    after(() => child.kill('SIGKILL'))
    let out = ''
    const base = await new Promise<string>((ok, fail) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        const m = /at (http:\/\/127\.0\.0\.1:\d+) .*\nToken: .*\n/.exec(out)
        if (m) ok(m[1]!)
      })
      child.on('exit', () => fail(new Error(`serve exited: ${out}`)))
    })
    const tokenFile = join(dir, '.cos-notebook', 'token')
    assert.match(out, new RegExp(`Token: ${tokenFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600)
    const token = readFileSync(tokenFile, 'utf8').trim()

    assert.equal((await fetch(`${base}/v1/notebooks`)).status, 401)
    const listed = await fetch(`${base}/v1/notebooks`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.deepEqual(await listed.json(), {
      notebooks: [{ notebook: 'personal:local:default', space: 'personal' }],
    })

    const client = new Client({ name: 'cli-test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}`, 'x-cos-client': 'cli-test' } },
      }),
    )
    const r = await client.callTool({
      name: 'apply_changes',
      arguments: { operations: [{ op: 'add', kind: 'idea', text: 'A reading nook' }] },
    })
    assert.equal(r.isError, undefined)
    await client.close()
    assert.equal(git(dir, 'log', '-1', '--format=%an').trim(), 'cli-test for Alex')

    child.kill('SIGTERM')
    assert.equal(await exited, 0)
  })

  it('refuses a folder with no notebook, and bad settings', async () => {
    const empty = await tempDir()
    const r = run(['serve', empty])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /has no notebook yet\. Start one with cos-notebook init/)
    const dir = await notebook()
    assert.match(run(['serve', dir, '--port', 'many']).stderr, /must be a number/)
    assert.match(
      run(['serve', dir], { COS_NOTEBOOK_ALLOWED_HOSTS: 'https://notebook.example.com' }).stderr,
      /isn't a host name/,
    )
  })
})

describe('cos-notebook mcp', () => {
  it('serves MCP over stdio, recording the client name from the handshake', async () => {
    const dir = await notebook()
    const client = new Client({ name: 'Stdio Agent', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, 'mcp', dir],
        env: { ...(process.env as Record<string, string>), COS_NOTEBOOK_PERSON: 'Alex' },
        stderr: 'pipe',
      }),
    )
    after(() => client.close())
    assert.equal((await client.listTools()).tools.length, 13)
    const session = (await client.callTool({
      name: 'start_session',
      arguments: {},
    })) as unknown as {
      structuredContent: { today: { date: string } }
    }
    assert.match(session.structuredContent.today.date, /^\d{4}-\d{2}-\d{2}$/)
    const r = await client.callTool({
      name: 'apply_changes',
      arguments: { operations: [{ op: 'add', kind: 'action', text: 'Water the ferns' }] },
    })
    assert.equal(r.isError, undefined)
    assert.match(readFileSync(join(dir, 'actions.md'), 'utf8'), /- \[ \] Water the ferns/)
    assert.equal(git(dir, 'log', '-1', '--format=%an').trim(), 'Stdio-Agent for Alex')
  })
})

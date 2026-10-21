import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tempDir } from '../helpers/tmp.ts'

const MANUAL = fileURLToPath(new URL('../../evals/manual.ts', import.meta.url))
const run = (...args: string[]) =>
  spawnSync(process.execPath, [MANUAL, ...args], { encoding: 'utf8' })

describe('evaluations by hand', () => {
  it('sets up a scenario, serves it over stdio, logs the calls and grades the result', async () => {
    const dir = await tempDir()
    const setup = run('setup', 'misheard-name', dir)
    assert.equal(setup.status, 0, setup.stderr)
    assert.match(setup.stdout, /1\. Voice note: remind me to follow up with Dana Whitfeld/)
    // The agent's instructions carry the person's lines only, never the checks.
    assert.doesNotMatch(setup.stdout, /no note for the misheard name/)
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as {
      mcpServers: { notebook: { command: string; args: string[] } }
    }

    const client = new Client({ name: 'hand-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: mcp.mcpServers.notebook.command,
        args: mcp.mcpServers.notebook.args,
        stderr: 'pipe',
      }),
    )
    const session = (await client.callTool({
      name: 'start_session',
      arguments: {},
    })) as unknown as {
      structuredContent: { today: { date: string } }
    }
    assert.equal(session.structuredContent.today.date, '2026-10-17')
    const add = {
      op: 'add',
      kind: 'action',
      text: 'Follow up with Dana Whitfield about the launch date',
      due: '2026-10-19',
    }
    const notebook = 'workspace:northwind:alex'
    const refused = await client.callTool({
      name: 'apply_changes',
      arguments: { notebook, operations: [{ ...add, person: 'Dana Whitfeld' }] },
    })
    assert.equal(refused.isError, true)
    await client.callTool({
      name: 'apply_changes',
      arguments: { notebook, operations: [{ ...add, person: 'Dana Whitfield' }] },
    })
    await client.close()

    const check = run('check', dir)
    assert.equal(check.status, 0, check.stdout + check.stderr)
    assert.match(check.stdout, /^PASS misheard-name/)
    assert.match(
      check.stdout,
      /Tool calls: start_session, apply_changes \(refused: close_name\), apply_changes/,
    )
    assert.match(check.stdout, /Calls 3\/3, refused 1, writes 1, duplicates 0, wrong place 0/)
    const log = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    assert.doesNotMatch(log, /launch date|Whitf/)
  })

  it("fails a scenario the agent didn't do", async () => {
    const dir = await tempDir()
    assert.equal(run('setup', 'complete-by-phrase', dir).status, 0)
    const check = run('check', dir)
    assert.equal(check.status, 1)
    assert.match(check.stdout, /FAIL the pricing deck action is done: still open/)
  })
})

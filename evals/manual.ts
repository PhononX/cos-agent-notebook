// Running the evaluations by hand, with any MCP client as the agent (Claude Code, Claude Desktop)
// instead of the API:
//
//   node evals/manual.ts setup <scenario> [dir]   fresh notebooks, and the lines to say
//   node evals/manual.ts serve [dir]              the MCP server the agent connects to (stdio)
//   node evals/manual.ts check [dir]              grade the scenario set up last
//   node evals/manual.ts list                     the scenarios
//
// `serve` is the server in front of the eval notebooks, with the clock set to the scenarios'
// Saturday morning. It logs each tool call (name, refused or not, error code, result size; never
// arguments or text) so `check` can count them. See .claude/skills/run-evals/SKILL.md.

import { appendFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createLocalService } from '../src/adapters/local/index.ts'
import { buildMcpServer, clientId } from '../src/adapters/mcp/server.ts'
import type { Access, NotebookService } from '../src/domain/service.ts'
import type { Logger } from '../src/domain/ports.ts'
import {
  duplicatesCreated,
  grade,
  snapshot,
  viewOf,
  WRITE_TOOLS,
  type Snapshot,
} from './harness.ts'
import { NOW, PERSONAL, TIMEZONE, WORK, seedNotebooks } from './notebooks.ts'
import { SCENARIOS } from './scenarios.ts'

const ACCESS: Access = { notebooks: [PERSONAL, WORK] }
const SILENT: Logger = { info() {}, warn() {}, error() {} }
const DEFAULT_DIR = join(tmpdir(), 'cos-notebook-eval')

interface State {
  scenario: string
  before: Snapshot
}

interface LoggedCall {
  tool: string
  refused: boolean
  code?: string
  write: boolean
  chars: number
}

/** The scenarios' clock: Saturday 10:05 in New York when the server starts, then real time. */
function evalClock() {
  const started = Date.now()
  return { now: () => new Date(NOW.getTime() + (Date.now() - started)) }
}

function serviceFor(dir: string): NotebookService {
  return createLocalService({
    root: dir,
    logger: SILENT,
    clock: evalClock(),
    defaultTimezone: TIMEZONE,
  })
}

async function setup(name: string | undefined, dir: string) {
  const scenario = SCENARIOS.find((s) => s.name === name)
  if (!scenario) {
    throw new Error(
      `Name a scenario: ${SCENARIOS.map((s) => s.name).join(', ')}. Usage: setup <scenario> [dir]`,
    )
  }
  await rm(join(dir, 'personal'), { recursive: true, force: true })
  await rm(join(dir, 'workspaces'), { recursive: true, force: true })
  await mkdir(join(dir, 'agent'), { recursive: true })
  const service = serviceFor(dir)
  await seedNotebooks(service)
  const state: State = { scenario: scenario.name, before: await snapshot(service, ACCESS) }
  await writeFile(join(dir, 'eval.json'), `${JSON.stringify(state, null, 2)}\n`)
  await writeFile(join(dir, 'calls.jsonl'), '')
  const script = fileURLToPath(import.meta.url)
  const mcp = {
    mcpServers: { notebook: { command: process.execPath, args: [script, 'serve', dir] } },
  }
  await writeFile(join(dir, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)

  console.log(`Fresh notebooks for "${scenario.name}" in ${dir}.`)
  console.log(`MCP server config: ${join(dir, 'mcp.json')}`)
  console.log()
  console.log('Start a new conversation with the agent, from an empty folder, so it sees only the')
  console.log('notebook tools, not this repository. Send each line as its own message and wait for')
  console.log('the reply. If the agent asks a question, answer briefly as Alex. Then run check.')
  console.log()
  scenario.turns.forEach((turn, i) => console.log(`${i + 1}. ${turn}`))
}

async function serve(dir: string) {
  const service = serviceFor(dir)
  // Seed on first use, so the server can be registered before the first setup.
  if (!(await readFile(join(dir, 'eval.json'), 'utf8').catch(() => ''))) {
    await mkdir(dir, { recursive: true })
    await seedNotebooks(service)
  }
  let client: string | undefined
  const server = buildMcpServer({
    service,
    principal: { access: ACCESS, person: 'Alex' },
    clientName: () => client,
    version: '0.0.0',
  })
  server.server.oninitialized = () => {
    client = clientId(server.server.getClientVersion()?.name, 'mcp')
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Watch tools/call requests and their answers on the wire.
  type Wire = {
    id?: string | number
    method?: string
    params?: { name?: string; arguments?: Record<string, unknown> }
    result?: {
      isError?: boolean
      content?: { text?: string }[]
      structuredContent?: { error?: { code?: string } }
    }
    error?: unknown
  }
  const pending = new Map<string | number, { tool: string; dryRun: boolean }>()
  const receive = transport.onmessage!
  transport.onmessage = (message) => {
    const m = message as Wire
    if (m.method === 'tools/call' && m.id !== undefined) {
      pending.set(m.id, {
        tool: m.params?.name ?? '?',
        dryRun: m.params?.arguments?.dry_run === true,
      })
    }
    receive(message)
  }
  const send = transport.send.bind(transport)
  transport.send = async (message) => {
    const m = message as Wire
    const call = m.id !== undefined ? pending.get(m.id) : undefined
    if (call && m.id !== undefined) {
      pending.delete(m.id)
      const refused = m.error !== undefined || m.result?.isError === true
      const code = m.error
        ? 'protocol'
        : refused
          ? (m.result?.structuredContent?.error?.code ?? 'invalid_arguments')
          : undefined
      const entry: LoggedCall = {
        tool: call.tool,
        refused,
        ...(code ? { code } : {}),
        write: WRITE_TOOLS.has(call.tool) && !refused && !call.dryRun,
        chars: (m.result?.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0),
      }
      appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(entry)}\n`)
    }
    return send(message)
  }
}

async function check(dir: string) {
  const state = JSON.parse(
    await readFile(join(dir, 'eval.json'), 'utf8').catch(() => 'null'),
  ) as State | null
  if (!state) throw new Error(`Nothing set up in ${dir}. Run setup <scenario> first.`)
  const scenario = SCENARIOS.find((s) => s.name === state.scenario)!
  const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LoggedCall)
  const service = serviceFor(dir)
  const checks = await grade(scenario, viewOf(service, ACCESS))
  const after = await snapshot(service, ACCESS)

  const budget = scenario.maxToolCalls * scenario.turns.length
  const writes = calls.filter((c) => c.write).length
  const refused = calls.filter((c) => c.refused)
  const metrics = {
    toolCalls: calls.length,
    toolCallBudget: budget,
    refusedCalls: refused.length,
    refusalCodes: refused.map((c) => c.code ?? '?'),
    writes,
    duplicatesCreated: duplicatesCreated(state.before, after),
    wrongPlace: checks.filter((c) => c.kind === 'filing' && !c.passed).length,
    resultTokens: Math.round(calls.reduce((n, c) => n + c.chars, 0) / 4),
  }
  const overBudget: string[] = []
  if (calls.length > budget) overBudget.push(`${calls.length} tool calls (budget ${budget})`)
  if (scenario.maxWrites !== undefined && writes > scenario.maxWrites) {
    overBudget.push(`${writes} writes (budget ${scenario.maxWrites})`)
  }
  if (metrics.duplicatesCreated) overBudget.push(`${metrics.duplicatesCreated} duplicates created`)
  const passed = checks.every((c) => c.passed) && !overBudget.length

  console.log(`${passed ? 'PASS' : 'FAIL'} ${scenario.name}`)
  for (const c of checks)
    console.log(`  ${c.passed ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`)
  for (const o of overBudget) console.log(`  FAIL ${o}`)
  console.log()
  console.log(
    `Tool calls: ${calls.map((c) => (c.refused ? `${c.tool} (refused: ${c.code})` : c.tool)).join(', ') || 'none'}`,
  )
  console.log(
    `Calls ${metrics.toolCalls}/${budget}, refused ${metrics.refusedCalls}, writes ${writes}, duplicates ${metrics.duplicatesCreated}, wrong place ${metrics.wrongPlace}, tokens read ~${metrics.resultTokens}`,
  )

  const outDir = fileURLToPath(new URL('./results/', import.meta.url))
  await mkdir(outDir, { recursive: true })
  const file = join(
    outDir,
    `manual-${scenario.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(
    file,
    `${JSON.stringify({ scenario: scenario.name, passed, checks, overBudget, metrics, calls }, null, 2)}\n`,
  )
  console.log(`Results: ${file}`)
  return passed
}

const [command, ...args] = process.argv.slice(2)
const dirArg = (i: number) => resolve(args[i] ?? DEFAULT_DIR)
if (command === 'setup') await setup(args[0], dirArg(1))
else if (command === 'serve') await serve(dirArg(0))
else if (command === 'check') process.exitCode = (await check(dirArg(0))) ? 0 : 1
else if (command === 'list') for (const s of SCENARIOS) console.log(`${s.name}: ${s.about}`)
else {
  console.error(
    'Usage: node evals/manual.ts setup <scenario> [dir] | serve [dir] | check [dir] | list',
  )
  process.exitCode = 2
}

// Runs one scenario: a fresh pair of notebooks on disk, the MCP server in front of them, and an
// agent talking to it over MCP, one exchange per scripted turn. Measures what SPEC.md asks of
// the evaluations: tool calls per exchange, refused calls, duplicates created, items filed in
// the wrong place, and tokens read.
//
// This is test tooling. The service itself never calls a model.

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLocalService } from '../src/adapters/local/index.ts'
import { buildMcpServer } from '../src/adapters/mcp/server.ts'
import { scoreName } from '../src/domain/names.ts'
import { formatRef, type NotebookRef } from '../src/domain/notebook-ref.ts'
import type { Logger } from '../src/domain/ports.ts'
import type { Access, NotebookService } from '../src/domain/service.ts'
import { NOW, PERSONAL, TIMEZONE, WORK, seedNotebooks } from './notebooks.ts'
import type { Scenario, Space, ToolCall, View } from './scenarios.ts'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Message = Anthropic.Beta.Messages.BetaMessage
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam

/** The one call the harness makes to a model, so tests can script it. */
export interface Model {
  create(params: Params): Promise<Message>
}

export interface RunOptions {
  model: Model
  modelId: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Server-side refusal fallbacks (the served model is recorded either way). */
  fallbacks: boolean
  /** Where each run's notebooks are made. */
  workDir: string
  /** Keep the notebooks after the run, to look at them. */
  keep?: boolean
  /** Model calls allowed in one exchange before it is cut off. */
  maxSteps?: number
}

export interface CallRecord {
  name: string
  refused: boolean
  /** The refusal's error code, `invalid_arguments` for schema errors. */
  code?: string
  write: boolean
  resultChars: number
}

export interface ExchangeRecord {
  turn: string
  calls: CallRecord[]
  stopReason: string | null
  reply: string
}

export interface Metrics {
  toolCalls: number
  maxToolCallsPerExchange: number
  refusedCalls: number
  writes: number
  duplicatesCreated: number
  wrongPlace: number
  /** Tool results the agent read, in tokens, estimated at four characters a token. */
  resultTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ScenarioResult {
  scenario: string
  passed: boolean
  checks: { name: string; kind: string; passed: boolean; detail?: string }[]
  overBudget: string[]
  metrics: Metrics
  exchanges: ExchangeRecord[]
  servedBy: string[]
  notebooks?: string
  error?: string
}

const WRITE_TOOLS = new Set([
  'apply_changes',
  'write_brief',
  'update_catch_up',
  'save_draft',
  'clear_nudges',
  'undo',
])

const SILENT: Logger = { info() {}, warn() {}, error() {} }

const REFS: Record<Space, NotebookRef> = { personal: PERSONAL, work: WORK }

/** The system prompt is deliberately thin: the tools and their descriptions must carry the work. */
export function systemPrompt(serverInstructions: string | undefined): string {
  return [
    "You are Alex's chief of staff. Alex talks to you in short messages, often by voice.",
    'You keep their notebook with the tools you have. Reply briefly.',
    serverInstructions ? `The notebook service says: ${serverInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const root = await mkdtemp(join(opts.workDir, `${scenario.name}-`))
  let t = NOW.getTime()
  const service = createLocalService({
    root,
    logger: SILENT,
    clock: { now: () => new Date((t += 1000)) },
    defaultTimezone: TIMEZONE,
  })
  await seedNotebooks(service)
  const access: Access = { notebooks: [PERSONAL, WORK] }
  const before = await snapshot(service, access)

  const server = buildMcpServer({
    service,
    principal: { access, person: 'Alex' },
    clientName: () => 'eval-agent',
    version: '0.0.0',
  })
  const client = new Client({ name: 'eval-agent', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])

  const exchanges: ExchangeRecord[] = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const servedBy = new Set<string>()
  let error: string | undefined
  try {
    const tools: Anthropic.Beta.Messages.BetaTool[] = (await client.listTools()).tools.map(
      (tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      }),
    )
    const system = systemPrompt(client.getInstructions())
    const messages: MessageParam[] = []

    for (const turn of scenario.turns) {
      messages.push({ role: 'user', content: turn })
      const record: ExchangeRecord = { turn, calls: [], stopReason: null, reply: '' }
      exchanges.push(record)
      for (let step = 0; step < (opts.maxSteps ?? 12); step++) {
        const response = await opts.model.create({
          model: opts.modelId,
          max_tokens: 16000,
          system,
          tools,
          messages,
          output_config: { effort: opts.effort },
          cache_control: { type: 'ephemeral' },
          ...(opts.fallbacks
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
        })
        servedBy.add(response.model)
        usage.input += response.usage.input_tokens
        usage.output += response.usage.output_tokens
        usage.cacheRead += response.usage.cache_read_input_tokens ?? 0
        usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0
        messages.push({ role: 'assistant', content: response.content })
        record.stopReason = response.stop_reason
        const text = response.content
          .filter((c): c is Anthropic.Beta.Messages.BetaTextBlock => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        if (text) record.reply = record.reply ? `${record.reply}\n${text}` : text
        if (response.stop_reason === 'pause_turn') continue
        if (response.stop_reason !== 'tool_use') break

        // Run the calls in order (writes depend on each other) and answer them in one message.
        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          const args = (block.input ?? {}) as Record<string, unknown>
          const { text: result, call } = await callTool(client, block.name, args)
          record.calls.push(call)
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
            ...(call.refused ? { is_error: true } : {}),
          })
        }
        messages.push({ role: 'user', content: results })
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    await client.close()
  }

  const view = viewOf(service, access)
  const checks = []
  for (const check of scenario.checks) {
    const r = await check.test(view)
    checks.push({
      name: check.name,
      kind: check.kind,
      passed: r === true,
      ...(r === true ? {} : { detail: r }),
    })
  }
  const after = await snapshot(service, access)
  const calls = exchanges.flatMap((e) => e.calls)
  const metrics: Metrics = {
    toolCalls: calls.length,
    maxToolCallsPerExchange: Math.max(0, ...exchanges.map((e) => e.calls.length)),
    refusedCalls: calls.filter((c) => c.refused).length,
    writes: calls.filter((c) => c.write).length,
    duplicatesCreated: duplicatesCreated(before, after),
    wrongPlace: checks.filter((c) => c.kind === 'filing' && !c.passed).length,
    resultTokens: Math.round(calls.reduce((n, c) => n + c.resultChars, 0) / 4),
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  }
  const overBudget: string[] = []
  if (metrics.maxToolCallsPerExchange > scenario.maxToolCalls) {
    overBudget.push(
      `${metrics.maxToolCallsPerExchange} tool calls in one exchange (budget ${scenario.maxToolCalls})`,
    )
  }
  if (scenario.maxWrites !== undefined && metrics.writes > scenario.maxWrites) {
    overBudget.push(`${metrics.writes} writes (budget ${scenario.maxWrites})`)
  }
  if (metrics.duplicatesCreated) overBudget.push(`${metrics.duplicatesCreated} duplicates created`)

  if (!opts.keep) await rm(root, { recursive: true, force: true })
  return {
    scenario: scenario.name,
    passed: !error && checks.every((c) => c.passed) && !overBudget.length,
    checks,
    overBudget,
    metrics,
    exchanges,
    servedBy: [...servedBy],
    ...(opts.keep ? { notebooks: root } : {}),
    ...(error ? { error } : {}),
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; call: CallRecord }> {
  let text: string
  let refused: boolean
  let code: string | undefined
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content?: { type: string; text?: string }[]
      structuredContent?: { error?: { code?: string } }
    }
    text = (result.content ?? []).map((c) => c.text ?? '').join('\n')
    refused = result.isError === true
    if (refused) code = result.structuredContent?.error?.code ?? 'invalid_arguments'
  } catch (e) {
    text = e instanceof Error ? e.message : String(e)
    refused = true
    code = 'protocol'
  }
  return {
    text,
    call: {
      name,
      refused,
      ...(code ? { code } : {}),
      write: WRITE_TOOLS.has(name) && !refused && args.dry_run !== true,
      resultChars: text.length,
    },
  }
}

function viewOf(service: NotebookService, access: Access): View {
  return {
    async items(space, filter = {}) {
      const r = (await service.getItems(access, {
        notebooks: [formatRef(REFS[space])],
        status: filter.status ?? 'all',
        ...(filter.kinds ? { kinds: filter.kinds } : {}),
        limit: 200,
      })) as { items: Awaited<ReturnType<View['items']>> }
      return r.items
    },
    async notes(space) {
      return (await service.listNotes(REFS[space])).map((n) => n.path)
    },
  }
}

interface Snapshot {
  duplicates: number
  names: Map<string, string[]>
}

const NAMED = /^(people|projects|areas)\/(.+)\.md$/

async function snapshot(service: NotebookService, access: Access): Promise<Snapshot> {
  const review = (await service.reviewCandidates(access, { kinds: ['duplicate'], limit: 200 })) as {
    total: number
  }
  const names = new Map<string, string[]>()
  for (const ref of access.notebooks) {
    const list = (await service.listNotes(ref))
      .map((n) => NAMED.exec(n.path)?.[2])
      .filter((n): n is string => n !== undefined)
    names.set(formatRef(ref), list)
  }
  return { duplicates: review.total, names }
}

/** New duplicate items, plus new notes whose name is close to a note that was already there. */
function duplicatesCreated(before: Snapshot, after: Snapshot): number {
  let n = Math.max(0, after.duplicates - before.duplicates)
  for (const [ref, names] of after.names) {
    const old = before.names.get(ref) ?? []
    for (const name of names) {
      if (old.includes(name)) continue
      if (old.some((o) => scoreName(name, o) >= 0.8)) n++
    }
  }
  return n
}

/** A model that makes the scenario's ideal calls, one per step, then ends each turn. */
export function scriptedModel(ideal: ToolCall[][]): Model {
  return {
    async create(params) {
      const userTurns = params.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.role === 'user' && typeof m.content === 'string')
      const turn = userTurns.length - 1
      const start = userTurns[turn]!.i
      const step = params.messages.slice(start).filter((m) => m.role === 'assistant').length
      const call = ideal[turn]?.[step]
      const content = call
        ? [
            {
              type: 'tool_use',
              id: `toolu_${turn}_${step}`,
              name: call.name,
              input: call.arguments,
            },
          ]
        : [{ type: 'text', text: 'Done.', citations: null }]
      return {
        id: `msg_${turn}_${step}`,
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content,
        stop_reason: call ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Message
    },
  }
}

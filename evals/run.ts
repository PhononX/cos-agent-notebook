// npm run eval -- [--scenario <name>]... [--runs <n>] [--model <id>] [--effort <level>]
//                 [--no-fallbacks] [--keep] [--ideal]
//
// Replays the scenarios through a real agent connected over MCP and prints the measurements.
// Calls the Claude API (credentials from ANTHROPIC_API_KEY or an `ant auth login` profile), so it
// runs on demand, never in CI. --ideal replays each scenario's ideal calls instead, without a
// model, to check the setup for free. Full results go to evals/results/.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import {
  runScenario,
  scriptedModel,
  type Model,
  type RunOptions,
  type ScenarioResult,
} from './harness.ts'
import { SCENARIOS } from './scenarios.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', multiple: true },
    runs: { type: 'string', default: '1' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'medium' },
    'no-fallbacks': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    ideal: { type: 'boolean', default: false },
  },
})

const effort = EFFORTS.find((e) => e === values.effort)
if (!effort) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}.`)
const runs = Number(values.runs)
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a whole number from 1.')
const chosen = values.scenario?.length
  ? values.scenario.map((name) => {
      const s = SCENARIOS.find((x) => x.name === name)
      if (!s)
        throw new Error(
          `No scenario "${name}". Scenarios: ${SCENARIOS.map((x) => x.name).join(', ')}.`,
        )
      return s
    })
  : SCENARIOS

const anthropic = values.ideal ? null : new Anthropic()
const live: Model | null = anthropic
  ? { create: (params) => anthropic.beta.messages.create(params) }
  : null
const workDir = await mkdtemp(join(tmpdir(), 'cos-notebook-eval-'))

const results: ScenarioResult[] = []
for (const scenario of chosen) {
  for (let run = 1; run <= runs; run++) {
    const opts: RunOptions = {
      model: live ?? scriptedModel(scenario.ideal),
      modelId: values.ideal ? 'scripted' : values.model,
      effort,
      fallbacks: !values['no-fallbacks'],
      workDir,
      keep: values.keep,
    }
    const r = await runScenario(scenario, opts)
    results.push(r)
    const failed = [
      ...r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`),
      ...r.overBudget,
    ]
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${scenario.name}${runs > 1 ? ` #${run}` : ''}`)
    for (const f of failed) console.log(`     ${f}`)
    if (r.error) console.log(`     error: ${r.error}`)
    if (r.notebooks) console.log(`     notebooks: ${r.notebooks}`)
  }
}

console.log()
console.table(
  chosen.map((s) => {
    const rs = results.filter((r) => r.scenario === s.name)
    const mean = (f: (r: ScenarioResult) => number) =>
      Math.round((rs.reduce((n, r) => n + f(r), 0) / rs.length) * 10) / 10
    return {
      scenario: s.name,
      passed: `${rs.filter((r) => r.passed).length}/${rs.length}`,
      'calls/exchange': mean((r) => r.metrics.toolCalls / Math.max(1, r.exchanges.length)),
      'max calls': Math.max(...rs.map((r) => r.metrics.maxToolCallsPerExchange)),
      refused: mean((r) => r.metrics.refusedCalls),
      writes: mean((r) => r.metrics.writes),
      duplicates: mean((r) => r.metrics.duplicatesCreated),
      'wrong place': mean((r) => r.metrics.wrongPlace),
      'tokens read': mean((r) => r.metrics.resultTokens),
      'input tokens': mean(
        (r) => r.metrics.inputTokens + r.metrics.cacheReadTokens + r.metrics.cacheWriteTokens,
      ),
      'output tokens': mean((r) => r.metrics.outputTokens),
    }
  }),
)

const outDir = fileURLToPath(new URL('./results/', import.meta.url))
await mkdir(outDir, { recursive: true })
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
await writeFile(
  file,
  `${JSON.stringify({ model: values.ideal ? 'scripted' : values.model, effort, runs, results }, null, 2)}\n`,
)
console.log(`Results: ${file}`)
process.exitCode = results.every((r) => r.passed) ? 0 : 1

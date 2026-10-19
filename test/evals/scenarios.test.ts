// The evaluations call a model and run on demand (npm run eval). These tests replay each
// scenario's ideal calls instead, so CI proves the scenarios, checks and metrics hold together.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runScenario, scriptedModel, type RunOptions } from '../../evals/harness.ts'
import { SCENARIOS, type Scenario } from '../../evals/scenarios.ts'
import { tempDir } from '../helpers/tmp.ts'

async function replay(scenario: Scenario, ideal = scenario.ideal) {
  const opts: RunOptions = {
    model: scriptedModel(ideal),
    modelId: 'scripted',
    effort: 'medium',
    fallbacks: false,
    workDir: await tempDir(),
  }
  return runScenario(scenario, opts)
}

const byName = (name: string) => SCENARIOS.find((s) => s.name === name)!

describe('evaluation scenarios', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: the ideal calls pass every check within budget`, async () => {
      assert.equal(scenario.ideal.length, scenario.turns.length)
      const r = await replay(scenario)
      assert.equal(r.error, undefined)
      assert.deepEqual(
        r.checks.filter((c) => !c.passed),
        [],
      )
      assert.deepEqual(r.overBudget, [])
      assert.equal(r.metrics.refusedCalls, 0)
      assert.equal(r.metrics.wrongPlace, 0)
      assert.equal(r.passed, true)
    })
  }

  it('counts an item filed in the wrong notebook', async () => {
    const s = byName('file-by-space')
    const r = await replay(s, [
      [
        { name: 'start_session', arguments: {} },
        {
          name: 'apply_changes',
          arguments: {
            notebook: 'workspace:northwind:alex',
            operations: [
              { op: 'add', kind: 'idea', text: 'Learn Portuguese next year' },
              { op: 'add', kind: 'fact', text: "Northwind's fiscal year starts in February" },
            ],
          },
        },
      ],
    ])
    assert.equal(r.metrics.wrongPlace, 1)
    assert.equal(r.passed, false)
  })

  it('counts refused calls and a person created from a misheard name', async () => {
    const s = byName('misheard-name')
    const add = {
      op: 'add',
      kind: 'action',
      text: 'Follow up with Dana Whitfeld about the launch date',
      person: 'Dana Whitfeld',
      due: '2026-10-19',
    }
    const r = await replay(s, [
      [
        { name: 'start_session', arguments: {} },
        {
          name: 'apply_changes',
          arguments: { notebook: 'workspace:northwind:alex', operations: [add] },
        },
        {
          name: 'apply_changes',
          arguments: {
            notebook: 'workspace:northwind:alex',
            operations: [add, { op: 'note', type: 'person', name: 'Dana Whitfeld' }],
            confirm_new_names: ['Dana Whitfeld'],
          },
        },
      ],
    ])
    assert.equal(r.metrics.refusedCalls, 1)
    assert.equal(r.exchanges[0]!.calls[1]!.code, 'close_name')
    assert.equal(r.metrics.duplicatesCreated, 1)
    assert.equal(r.metrics.writes, 1)
    assert.ok(r.checks.some((c) => c.name === 'no note for the misheard name' && !c.passed))
  })

  it('counts writes against a scenario that should only read', async () => {
    const s = byName('ask-before-reorganizing')
    const r = await replay(s, [
      [
        { name: 'start_session', arguments: {} },
        {
          name: 'apply_changes',
          arguments: {
            notebook: 'workspace:northwind:alex',
            operations: [{ op: 'archive', match: 'pricing deck', why: 'overdue' }],
          },
        },
      ],
    ])
    assert.deepEqual(r.overBudget, ['1 writes (budget 0)'])
    assert.equal(r.passed, false)
  })
})

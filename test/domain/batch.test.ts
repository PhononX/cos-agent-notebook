import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { itemId } from '../../src/format/ids.ts'
import { fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, NB, TODAY, fixtureService } from '../helpers/service.ts'

const original = fixtureNotes()
const lineOf = (path: string, start: string) =>
  original
    .get(path)!
    .split('\n')
    .find((l) => l.includes(start))!
const idOf = (path: string, start: string) => itemId(path, lineOf(path, start), 0)

async function snapshot(store: {
  list(nb: string): Promise<string[]>
  read(nb: string, p: string): Promise<string | null>
}) {
  const out = new Map<string, string | null>()
  for (const p of await store.list(NB)) out.set(p, await store.read(NB, p))
  return out
}

describe('apply_changes batches', () => {
  it('applies several operations as one change with one history entry and one log line', async () => {
    const { apply, read, history } = await fixtureService()
    const r = await apply([
      { op: 'decide', text: 'Annual discount capped at 10%', person: 'Dana Whitfield' },
      {
        op: 'add',
        kind: 'action',
        text: 'Tell Dana about the cap',
        person: 'Dana Whitfield',
        due: '2026-10-19',
      },
      { op: 'note', type: 'person', name: 'Dana Whitfield', front_matter: { last_talked: TODAY } },
    ])
    assert.match(r.change_id!, /^ch_[0-9a-z]{8}$/)
    assert.equal(history.commits.get(NB)!.length, 1)
    const commit = history.commits.get(NB)![0]!
    assert.equal(commit.author.name, 'claude-desktop for Alex')
    assert.equal(commit.summary, r.summary)
    assert.deepEqual(
      r.files.map((f) => f.path),
      ['actions.md', 'decisions.md', `log/${TODAY}.md`, 'people/Dana Whitfield.md'],
    )
    assert.equal(
      await read(`log/${TODAY}.md`),
      `# ${TODAY}\n\n- 10:05 Decided "Annual discount capped at 10% with [[Dana Whitfield]]"; Added "Tell [[Dana Whitfield]] about the cap" to actions.md; Updated people/Dana Whitfield.md [by:: claude-desktop for Alex] [change:: ${r.change_id}]\n`,
    )
  })

  it('appends to an existing daily log', async () => {
    const { apply, read } = await fixtureService({ now: new Date('2026-10-15T20:00:00Z') })
    const r = await apply([{ op: 'add', kind: 'inbox', text: 'Check the venue contract' }])
    assert.equal(
      await read('log/2026-10-15.md'),
      `${original.get('log/2026-10-15.md')}- 16:00 Added "Check the venue contract" to inbox.md [by:: claude-desktop for Alex] [change:: ${r.change_id}]\n`,
    )
  })

  it('writes nothing when any operation is refused', async () => {
    const { apply, store, history } = await fixtureService()
    const before = await snapshot(store)
    const e = await refusal(
      apply([
        { op: 'add', kind: 'action', text: 'A fine action' },
        { op: 'complete', id: 'zzzzzz' },
      ]),
    )
    assert.equal(e.operation, 1)
    assert.deepEqual(await snapshot(store), before)
    assert.equal(history.commits.get(NB)!.length, 0)
  })

  it('puts files back when writing fails part way', async () => {
    const { apply, store } = await fixtureService()
    const before = await snapshot(store)
    store.failAfter = 1
    await assert.rejects(
      apply([
        { op: 'add', kind: 'action', text: 'One' },
        { op: 'add', kind: 'idea', text: 'Two' },
      ]),
      /disk full/,
    )
    assert.deepEqual(await snapshot(store), before)
  })

  it('previews a dry run as before and after lines, writing nothing', async () => {
    const { apply, store } = await fixtureService()
    const before = await snapshot(store)
    const id = idOf('ideas.md', 'A referral program')
    const r = await apply([{ op: 'promote', id, project: 'Referral program' }], { dry_run: true })
    assert.equal(r.dry_run, true)
    assert.equal(r.change_id, null)
    assert.deepEqual(
      r.results[0]!.changes.map((c) => c.file),
      ['ideas.md', 'projects/Referral program.md'],
    )
    assert.deepEqual(r.results[0]!.changes[0]!.after, [])
    assert.equal(r.results[0]!.changes[0]!.before[0], lineOf('ideas.md', 'A referral program'))
    assert.ok(r.results[0]!.changes[1]!.after.includes(lineOf('ideas.md', 'A referral program')))
    assert.deepEqual(await snapshot(store), before)
    // The same call for real gives the same result.
    const real = await apply([{ op: 'promote', id, project: 'Referral program' }])
    assert.deepEqual(real.results[0]!.changes, r.results[0]!.changes)
  })

  it('returns the first result when a key is repeated, without writing again', async () => {
    const { apply, history } = await fixtureService()
    const ops = [{ op: 'add', kind: 'action', text: 'Book flights for the offsite' }]
    const first = await apply(ops, { idempotency_key: 'retry-key-0001' })
    const second = await apply(ops, { idempotency_key: 'retry-key-0001' })
    assert.equal(second.replayed, true)
    assert.equal(second.change_id, first.change_id)
    assert.equal(history.commits.get(NB)!.length, 1)
    const e = await refusal(
      apply([{ op: 'add', kind: 'action', text: 'Something else' }], {
        idempotency_key: 'retry-key-0001',
      }),
    )
    assert.equal(e.code, 'idempotency_mismatch')
  })

  it('lets later operations use ids read before the call', async () => {
    const { apply } = await fixtureService()
    const id = idOf('actions.md', 'Reply to [[Jordan Kim]]')
    const r = await apply([
      { op: 'update', id, fields: { due: '2026-10-20' } },
      { op: 'complete', id },
    ])
    assert.equal(r.results[0]!.items[0]!.id, null)
    assert.equal(r.results[0]!.items[0]!.previous_id, id)
    assert.match(
      r.results[1]!.items[0]!.line,
      /^- \[x\] Reply to .*\[due:: 2026-10-20\] \[done:: 2026-10-17\]/,
    )
    assert.match(r.results[1]!.items[0]!.id!, /^[0-9a-z]{6}$/)
  })

  it('refuses an id whose line changed, giving the current text', async () => {
    const { apply } = await fixtureService()
    const id = idOf('actions.md', 'Renew the design tool')
    await apply([{ op: 'update', id, text: 'Renew the design and video tool licences' }])
    const e = await refusal(apply([{ op: 'complete', id }]))
    assert.equal(e.code, 'stale_id')
    assert.match(
      e.message,
      /It was: "Renew the design tool licences" in actions\.md\. Now it reads: [0-9a-z]{6} "Renew the design and video tool licences"/,
    )
  })

  it("computes today in the notebook's time zone", async () => {
    // 02:30 UTC on the 18th is still the 17th in New York.
    const { apply, read } = await fixtureService({ now: new Date('2026-10-18T02:30:00Z') })
    const r = await apply([{ op: 'add', kind: 'inbox', text: 'Late thought' }])
    assert.equal(r.results[0]!.items[0]!.line, '- Late thought [src:: cv 2026-10-17]')
    assert.match(await read('log/2026-10-17.md'), /- 22:30 Added "Late thought"/)
  })

  it('falls back to the default time zone, with a warning, when my-rules has a bad one', async () => {
    const { apply, store } = await fixtureService({ now: new Date('2026-10-18T02:30:00Z') })
    const rules = (await store.read(NB, 'my-rules.md'))!.replace('America/New_York', 'Moon/Base')
    await store.write(NB, [{ path: 'my-rules.md', content: rules }])
    const r = await apply([{ op: 'add', kind: 'inbox', text: 'Late thought' }])
    assert.equal(r.results[0]!.items[0]!.line, '- Late thought [src:: cv 2026-10-18]')
    assert.equal(r.warnings[0]!.code, 'timezone_invalid')
  })

  it('serializes concurrent calls to one notebook', async () => {
    const { apply, read } = await fixtureService()
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        apply([{ op: 'add', kind: 'inbox', text: `Parallel ${i}` }]),
      ),
    )
    const inbox = await read('inbox.md')
    for (let i = 0; i < 5; i++) assert.ok(inbox.includes(`- Parallel ${i} [src::`))
  })

  it('refuses unknown notebooks and bad notebook ids', async () => {
    const { service } = await fixtureService()
    assert.equal(
      (
        await refusal(
          service.applyChanges('other', { operations: [{ op: 'log', text: 'x' }] }, AGENT),
        )
      ).code,
      'not_a_notebook',
    )
    assert.equal(
      (
        await refusal(
          service.applyChanges('../x', { operations: [{ op: 'log', text: 'x' }] }, AGENT),
        )
      ).code,
      'invalid_request',
    )
  })
})

describe('undo', () => {
  it('reverts a change as a new change, keeping the log', async () => {
    const { apply, service, read, history } = await fixtureService()
    const r = await apply([
      { op: 'complete', match: 'Reply to Jordan' },
      { op: 'add', kind: 'idea', text: 'Office hours for customers' },
    ])
    const u = await service.undo(NB, r.change_id!, AGENT)
    assert.equal(await read('actions.md'), original.get('actions.md'))
    assert.equal(await read('ideas.md'), original.get('ideas.md'))
    assert.equal(history.commits.get(NB)!.length, 2)
    const log = await read(`log/${TODAY}.md`)
    assert.match(
      log,
      new RegExp(
        `\\[change:: ${r.change_id}\\]\\n- 10:05 Undid ${r.change_id} \\(.*\\) \\[by:: claude-desktop for Alex\\] \\[change:: ${u.change_id}\\]\\n$`,
      ),
    )
  })

  it('refuses unknown change ids and changes already undone', async () => {
    const { apply, service } = await fixtureService()
    assert.equal((await refusal(service.undo(NB, 'ch_zzzzzzzz', AGENT))).code, 'not_found')
    assert.equal((await refusal(service.undo(NB, 'nope', AGENT))).code, 'invalid_value')
    const r = await apply([{ op: 'add', kind: 'idea', text: 'Office hours' }])
    await service.undo(NB, r.change_id!, AGENT)
    assert.equal((await refusal(service.undo(NB, r.change_id!, AGENT))).code, 'conflict')
  })
})

describe('logs', () => {
  it('never contain note content', async () => {
    const { apply, service, logger } = await fixtureService()
    const canary = 'Zanzibar-canary-7731'
    const r = await apply([
      { op: 'add', kind: 'fact', text: `The ${canary} fact`, person: 'Dana Whitfield' },
    ])
    await refusal(apply([{ op: 'complete', match: canary }]))
    await refusal(apply([{ op: 'add', kind: 'action', text: canary, person: 'Dana Whitfeld' }]))
    await service.undo(NB, r.change_id!, AGENT)
    assert.ok(logger.lines.length >= 4)
    for (const line of logger.lines) {
      assert.ok(!line.includes(canary), line)
      assert.ok(!line.includes('Dana'), line)
    }
  })
})

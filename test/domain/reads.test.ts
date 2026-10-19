import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { workspaceNotebook } from '../../src/domain/notebook-ref.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, NB, NOW, fixtureService } from '../helpers/service.ts'

const access = { notebooks: [NB] }

describe('get_items', () => {
  it('returns open items of a kind, compact, with their kind and notebook', async () => {
    const { service } = await fixtureService()
    const r = await service.getItems(access, { kinds: ['action'] })
    assert.ok(r.items.length >= 4)
    assert.ok(
      r.items.every(
        (i) => i.kind === 'action' && i.done === false && i.notebook === 'personal:alex:default',
      ),
    )
    assert.deepEqual(Object.keys(r.items[0]!).sort(), [
      'done',
      'fields',
      'file',
      'id',
      'kind',
      'links',
      'notebook',
      'quote',
      'text',
    ])
  })

  it('filters by person, due date, status and staleness', async () => {
    const { service } = await fixtureService()
    const dana = await service.getItems(access, { person: 'Dana Whitfield' })
    assert.ok(dana.items.some((i) => i.file === 'actions.md'))
    assert.ok(
      dana.items.some((i) => i.file === 'people/Dana Whitfield.md'),
      "the person's own note counts",
    )
    const overdue = await service.getItems(access, { kinds: ['action'], due_before: '2026-10-17' })
    assert.deepEqual(overdue.items.map((i) => i.fields.due).sort(), [
      '2026-10-14',
      '2026-10-16',
      '2026-10-16',
    ])
    const done = await service.getItems(access, { kinds: ['action', 'waiting'], status: 'done' })
    assert.equal(done.items.length, 3)
    const stale = await service.getItems(access, { kinds: ['idea'], untouched_days: 20 })
    assert.deepEqual(
      stale.items.map((i) => i.fields.src),
      ['cv 2026-09-24'],
    )
  })

  it('pages with limit and cursor', async () => {
    const { service } = await fixtureService()
    const first = await service.getItems(access, { status: 'all', limit: 5 })
    assert.equal(first.items.length, 5)
    assert.ok(first.next_cursor)
    const second = await service.getItems(access, {
      status: 'all',
      limit: 5,
      cursor: first.next_cursor!,
    })
    assert.notEqual(second.items[0]!.id, first.items[0]!.id)
    assert.equal(
      (await refusal(service.getItems(access, { cursor: 'nonsense' }))).code,
      'invalid_request',
    )
  })

  it("refuses notebooks the client can't read", async () => {
    const { service } = await fixtureService()
    const e = await refusal(service.getItems(access, { notebooks: ['workspace:northwind:alex'] }))
    assert.equal(e.code, 'forbidden')
  })
})

describe('search', () => {
  it('finds items with every word, the best match first, archive included', async () => {
    const { service } = await fixtureService()
    const r = await service.search(access, { query: 'pricing deck' })
    assert.match(r.items[0]!.text, /pricing deck/)
    const archived = await service.search(access, { query: 'conference sponsorship' })
    assert.equal(archived.items[0]!.file, 'archive/2026-10.md')
    assert.equal((await service.search(access, { query: 'zebra crossing' })).total, 0)
  })
})

describe('resolve_names', () => {
  it('reports existing, close and new names per notebook', async () => {
    const { service } = await fixtureService()
    const r = await service.resolveNames(access, {
      names: ['dana whitfield', 'Dana Whitfeld', 'Theo Brandt'],
    })
    assert.deepEqual(
      r.names.map((n) => n.notebooks[0]!.status),
      ['existing', 'close', 'new'],
    )
    assert.equal(r.names[0]!.notebooks[0]!.existing, 'Dana Whitfield')
  })
})

describe('get_review_candidates', () => {
  it('finds overdue, stale, never-nudged and recurring items', async () => {
    const { service } = await fixtureService()
    const r = await service.reviewCandidates(access, {})
    const kinds = new Set(r.candidates.map((c) => c.kind))
    for (const k of ['overdue', 'stale', 'never_nudged'] as const) assert.ok(kinds.has(k), k)
    assert.equal(r.stale_days, 21)
    const never = r.candidates.filter((c) => c.kind === 'never_nudged')
    assert.deepEqual(
      never.map((c) => c.items[0]!.text),
      ['[[Lena Fischer]]: signed renewal paperwork for Acme'],
    )
  })

  it('finds likely duplicates', async () => {
    const { service, apply } = await fixtureService()
    await apply([{ op: 'add', kind: 'inbox', text: 'Look at how Linear does its changelog page' }])
    const r = await service.reviewCandidates(access, { kinds: ['duplicate'] })
    assert.equal(r.candidates.length, 1)
    assert.equal(r.candidates[0]!.items.length, 2)
  })
})

describe('get_changes', () => {
  it('lists changes newest first, since a change id or a time', async () => {
    const { service, apply } = await fixtureService()
    const a = await apply([{ op: 'add', kind: 'inbox', text: 'First' }])
    const b = await apply([{ op: 'add', kind: 'inbox', text: 'Second' }])
    const all = await service.getChanges(access, {})
    assert.deepEqual(
      all.changes.map((c) => c.change_id),
      [b.change_id, a.change_id],
    )
    assert.equal(all.changes[0]!.by, 'claude-desktop for Alex')
    assert.deepEqual(all.changes[0]!.files.sort(), ['inbox.md', 'log/2026-10-17.md'])
    const since = await service.getChanges(access, { since: a.change_id! })
    assert.deepEqual(
      since.changes.map((c) => c.change_id),
      [b.change_id],
    )
    assert.equal((await service.getChanges(access, { since: NOW.toISOString() })).total, 0)
    assert.equal(
      (await refusal(service.getChanges(access, { since: 'yesterday' }))).code,
      'invalid_value',
    )
  })
})

describe('read_note', () => {
  it('can be limited to named sections', async () => {
    const { service } = await fixtureService()
    const r = await service.readNote(NB, 'actions.md', { sections: ['Elsewhere'] })
    assert.ok(r.text.startsWith('## Elsewhere'))
    assert.ok(r.items.every((i) => /Linear|Asana/.test(i.text)))
    assert.equal(
      (await refusal(service.readNote(NB, 'actions.md', { sections: ['Nope'] }))).code,
      'not_found',
    )
  })
})

describe('start_session', () => {
  it('returns today, profile, filing rules, focus, reminders and counts in one call', async () => {
    const { service } = await fixtureService()
    const s = await service.startSession(access, {}, AGENT)
    assert.deepEqual(s.today, {
      date: '2026-10-17',
      time: '10:05',
      weekday: 'Saturday',
      timezone: 'America/New_York',
    })
    assert.equal(s.profile.settings.nudges_per_day, 2)
    assert.ok(s.filing.rules.length >= 4)
    assert.match(s.filing.where_things_go[0]!.text, /Linear/)
    assert.equal(s.focus.length, 3)
    assert.equal(s.this_week.length, 3)
    assert.equal(s.reminders.length, 4)
    assert.deepEqual(s.counts[0], {
      notebook: 'personal:alex:default',
      open_actions: 5,
      due_today: 0,
      overdue: 3,
      waiting: 2,
      inbox: 5,
    })
  })

  it("shows changes others made since this client's last session, not its own", async () => {
    let tick = 0
    const clock = { now: () => new Date(NOW.getTime() + 1000 * tick++) }
    const { service, apply } = await fixtureService({ clock })
    await service.startSession(access, {}, AGENT)
    await apply([{ op: 'add', kind: 'inbox', text: 'From the agent itself' }])
    await apply(
      [{ op: 'complete', match: 'Reply to Jordan' }],
      {},
      { client: 'dashboard', person: 'Alex', source: 'page' },
    )
    const s = await service.startSession(access, {}, AGENT)
    assert.deepEqual(
      s.changes_by_others.changes.map((c) => c.by),
      ['dashboard for Alex'],
    )
    const again = await service.startSession(access, {}, AGENT)
    assert.ok(again.changes_by_others.changes.length <= 1)
  })

  it('needs the personal notebook, and finds the current workspace', async () => {
    const { service } = await fixtureService()
    const work = workspaceNotebook('northwind', 'alex')
    assert.equal(
      (await refusal(service.startSession({ notebooks: [work] }, {}, AGENT))).code,
      'invalid_value',
    )
    const e = await refusal(
      service.startSession(access, { workspace: 'workspace:northwind:alex' }, AGENT),
    )
    assert.match(e.message, /isn't one of this client's work notebooks/)
    const s = await service.startSession(
      access,
      { workspace: { source: 'slack', id: 'T1' } },
      AGENT,
    )
    assert.equal(s.current_workspace, null)
    assert.equal(s.warnings[0]!.code, 'unknown_workspace')
  })
})

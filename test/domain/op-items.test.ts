import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { itemId } from '../../src/format/ids.ts'
import { fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { TODAY, fixtureService } from '../helpers/service.ts'

const original = fixtureNotes()
const lineOf = (path: string, start: string) =>
  original
    .get(path)!
    .split('\n')
    .find((l) => l.includes(start))!
const idOf = (path: string, start: string) => itemId(path, lineOf(path, start), 0)

describe('complete', () => {
  it('checks off by id, adding done before src, keeping the quote', async () => {
    const { apply, read } = await fixtureService()
    const id = idOf('actions.md', 'Draft the uptime credit offer')
    const r = await apply([{ op: 'complete', id }])
    const line = `- [x] Draft the uptime credit offer for [[Lena Fischer]] [due:: 2026-10-16] [done:: ${TODAY}] [src:: cv 2026-10-14]`
    assert.equal(r.results[0]!.status, 'completed')
    assert.equal(r.results[0]!.items[0]!.line, line)
    assert.equal(r.results[0]!.items[0]!.previous_id, id)
    assert.notEqual(r.results[0]!.items[0]!.id, id)
    assert.deepEqual(r.results[0]!.changes, [
      {
        file: 'actions.md',
        before: [
          lineOf('actions.md', 'Draft the uptime'),
          '  > Something fair, maybe one month of credit. Have it ready by Friday.',
        ],
        after: [line, '  > Something fair, maybe one month of credit. Have it ready by Friday.'],
      },
    ])
    const after = await read('actions.md')
    assert.equal(
      after,
      original.get('actions.md')!.replace(lineOf('actions.md', 'Draft the uptime'), line),
    )
  })

  it('checks off by phrase', async () => {
    const { apply } = await fixtureService()
    const r = await apply([{ op: 'complete', match: 'reply to jordan' }])
    assert.match(r.results[0]!.items[0]!.line, /^- \[x\] Reply to \[\[Jordan Kim\]\]/)
  })

  it('refuses a phrase that matches nothing, naming the closest items', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'complete', match: 'slides for Dana', file: 'actions.md' }]),
    )
    assert.equal(e.code, 'not_found')
    assert.match(
      e.message,
      /No item matches "slides for Dana" in actions\.md\. Closest: [0-9a-z]{6} "Send the v3 pricing deck to \[\[Dana Whitfield\]\]/,
    )
    assert.ok(Array.isArray(e.details.candidates))
  })

  it('refuses a phrase that matches several items, listing them with ids', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(apply([{ op: 'complete', match: 'send' }]))
    assert.equal(e.code, 'ambiguous')
    assert.ok((e.details.candidates as unknown[]).length >= 2)
  })

  it('refuses ids that do not exist, and items that are not checkboxes', async () => {
    const { apply } = await fixtureService()
    assert.equal((await refusal(apply([{ op: 'complete', id: 'zzzzzz' }]))).code, 'not_found')
    const e = await refusal(apply([{ op: 'complete', id: idOf('ideas.md', 'A referral program') }]))
    assert.match(e.message, /isn't a checkbox item/)
  })

  it('leaves an already-done item alone', async () => {
    const { apply } = await fixtureService()
    const r = await apply([{ op: 'complete', id: idOf('actions.md', 'Send Q3 roadmap recap') }])
    assert.equal(r.change_id, null)
    assert.equal(r.results[0]!.warnings[0]!.code, 'already_done')
  })

  it('refuses to change a line that does not fit the format', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'complete', id: idOf('actions.md', 'Review the SSO release notes') }]),
    )
    assert.match(e.message, /doesn't fit the format/)
  })
})

describe('update', () => {
  it('changes text and fields, and keeps the waiting person first', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      {
        op: 'update',
        id: idOf('waiting.md', 'signed renewal paperwork'),
        text: 'countersigned renewal for Acme',
        fields: { nudged: TODAY },
      },
    ])
    assert.equal(
      r.results[0]!.items[0]!.line,
      `- [ ] [[Lena Fischer]]: countersigned renewal for Acme [since:: 2026-10-09] [nudged:: ${TODAY}] [src:: gmail 2026-10-09]`,
    )
  })

  it('removes fields, reopens items and replaces quotes', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'update', id: idOf('actions.md', 'Send Q3 roadmap recap'), done: false },
      {
        op: 'update',
        id: idOf('actions.md', 'Draft the uptime credit'),
        fields: { due: null },
        quote: null,
      },
    ])
    const a = await read('actions.md')
    assert.match(a, /\n- \[ \] Send Q3 roadmap recap to the team \[src:: cv 2026-10-08\]\n/)
    assert.match(
      a,
      /\n- \[ \] Draft the uptime credit offer for \[\[Lena Fischer\]\] \[src:: cv 2026-10-14\]\n- \[ \] Send Q3/,
    )
  })

  it('keeps the date on dated lines and refuses to edit decisions', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      {
        op: 'update',
        id: idOf('now.md', 'Senior PM finalist decision'),
        text: 'Senior PM offer call',
      },
    ])
    assert.equal(r.results[0]!.items[0]!.line, '- 2026-10-19 Senior PM offer call')
    const e = await refusal(
      apply([
        { op: 'update', id: idOf('decisions.md', 'SSO ships Oct 15'), text: 'SSO ships Oct 22' },
      ]),
    )
    assert.match(e.message, /decisions aren't edited/)
  })

  it('refuses to change src or edit the archive', async () => {
    const { apply } = await fixtureService()
    assert.match(
      (
        await refusal(
          apply([{ op: 'update', match: 'roadmap recap', fields: { src: 'cv 2026-10-01' } }]),
        )
      ).message,
      /src/,
    )
    const e = await refusal(
      apply([
        { op: 'update', id: idOf('archive/2026-10.md', 'conference sponsorship'), text: 'x' },
      ]),
    )
    assert.match(e.message, /archive/)
  })

  it('reports no change when nothing differs', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'update', match: 'roadmap recap', text: 'Send Q3 roadmap recap to the team' },
    ])
    assert.equal(r.results[0]!.status, 'unchanged')
    assert.equal(r.change_id, null)
  })
})

describe('archive', () => {
  it('moves the line and its quote to this month with archived, why and from', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'archive',
        match: 'uptime credit offer',
        file: 'actions.md',
        why: 'handled in the renewal call',
      },
    ])
    assert.equal(r.results[0]!.items[0]!.file, 'archive/2026-10.md')
    const arch = await read('archive/2026-10.md')
    assert.ok(
      arch.endsWith(
        `- [ ] Draft the uptime credit offer for [[Lena Fischer]] [due:: 2026-10-16] [archived:: ${TODAY}] [why:: handled in the renewal call] [from:: actions] [src:: cv 2026-10-14]\n  > Something fair, maybe one month of credit. Have it ready by Friday.\n`,
      ),
    )
    assert.ok(!(await read('actions.md')).includes('Draft the uptime'))
  })

  it('starts a new month file', async () => {
    const { apply, read } = await fixtureService({ now: new Date('2026-11-02T15:00:00Z') })
    await apply([{ op: 'archive', match: 'design tool licences', why: 'renewed automatically' }])
    assert.match(
      await read('archive/2026-11.md'),
      /^# Archive: November 2026\n\n- \[ \] Renew the design tool licences \[archived:: 2026-11-02\]/,
    )
  })

  it('refuses to archive a decision', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'archive', id: idOf('decisions.md', 'SSO ships'), why: 'old' }]),
    )
    assert.match(e.message, /superseded/)
  })
})

describe('move', () => {
  it('attaches an item to a project by linking it', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'move', match: 'Stripe sent a new invoice format', project: 'Q4 Launch' },
    ])
    assert.match(
      r.results[0]!.items[0]!.line,
      /affects the v3 billing page for \[\[Q4 Launch\]\] \[src::/,
    )
    assert.equal(r.results[0]!.items[0]!.file, 'inbox.md')
  })

  it('moves an inbox item to actions, adding a checkbox, and to a project note', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'move', match: 'changelog page', to_file: 'actions.md' },
      { op: 'move', match: 'Stripe sent a new invoice', to_file: 'projects/Q4 Launch.md' },
    ])
    assert.match(
      await read('actions.md'),
      /- \[ \] Look at how Linear does their changelog page \[src:: slack 2026-10-14 [^\]]+\]\n\n## Elsewhere/,
    )
    const q4 = await read('projects/Q4 Launch.md')
    assert.match(
      q4,
      /## Notes\n- The pricing page needs a comparison table \[src:: cv 2026-10-08\]\n- Stripe sent a new invoice format; check whether it affects the v3 billing page \[src:: cv 2026-10-13\]\n  > Something about Stripe/,
    )
    assert.ok(!(await read('inbox.md')).includes('Stripe'))
  })

  it('refuses to move into a person note that does not exist', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'move', match: 'changelog page', to_file: 'people/Theo Brandt.md' }]),
    )
    assert.match(e.message, /Create it first/)
  })
})

describe('decide', () => {
  it('appends a dated decision and marks the earlier one superseded', async () => {
    const { apply, read } = await fixtureService()
    const old = idOf('decisions.md', 'SSO ships Oct 15')
    const r = await apply([
      {
        op: 'decide',
        text: 'SSO ships Oct 22',
        person: 'Priya Natarajan',
        why: 'two blockers found',
        supersedes: { id: old },
      },
    ])
    const d = await read('decisions.md')
    assert.ok(
      d.includes(
        `- 2026-10-14 SSO ships Oct 15, with [[Priya Natarajan]] [why:: release notes are signed off] [superseded:: ${TODAY}] [src:: slack 2026-10-14]\n`,
      ),
    )
    assert.ok(
      d.endsWith(
        `- ${TODAY} SSO ships Oct 22 with [[Priya Natarajan]] [why:: two blockers found] [src:: cv ${TODAY}]\n`,
      ),
    )
    assert.equal(r.results[0]!.items.length, 2)
  })

  it('accepts add with kind decision', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'add', kind: 'decision', text: 'No discounts above 15%', why: 'protect margins' },
    ])
    assert.ok(
      (await read('decisions.md')).endsWith(
        `- ${TODAY} No discounts above 15% [why:: protect margins] [src:: cv ${TODAY}]\n`,
      ),
    )
  })

  it('does not record the same decision twice', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'decide', text: 'SSO ships Oct 15, with Priya Natarajan', date: '2026-10-14' },
    ])
    assert.equal(r.results[0]!.status, 'duplicate')
  })
})

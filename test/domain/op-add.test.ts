import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { refusal } from '../helpers/refusal.ts'
import { fixtureNotes } from '../helpers/fixture.ts'
import { TODAY, fixtureService } from '../helpers/service.ts'

const original = fixtureNotes()

describe('add', () => {
  it('writes a formatted action under To do from structured fields', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'add',
        kind: 'action',
        text: 'Send the board deck to Jordan Kim',
        person: 'Jordan Kim',
        due: '2026-10-20',
        src: 'cv 2026-10-17',
      },
    ])
    const line =
      '- [ ] Send the board deck to [[Jordan Kim]] [due:: 2026-10-20] [src:: cv 2026-10-17]'
    assert.equal(r.results[0]!.status, 'added')
    assert.deepEqual(
      r.results[0]!.items.map((i) => i.line),
      [line],
    )
    assert.match(r.results[0]!.items[0]!.id!, /^[0-9a-z]{6}$/)
    const actions = await read('actions.md')
    const lines = actions.split('\n')
    assert.equal(
      lines[lines.indexOf('* [ ] Renew the design tool licences [src:: gmail 2026-10-10]') + 1],
      line,
    )
    // Only that line changed.
    assert.equal(actions.replace(line + '\n', ''), original.get('actions.md'))
  })

  it('adds src from the client when the operation has none, dated today', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'add', kind: 'inbox', text: 'Look into usage-based billing for Acme' },
    ])
    assert.equal(
      r.results[0]!.items[0]!.line,
      `- Look into usage-based billing for Acme [src:: cv ${TODAY}]`,
    )
  })

  it('links a first name, or appends the link when the name is absent', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'add', kind: 'action', text: 'Call Dana about the discount', person: 'Dana Whitfield' },
      { op: 'add', kind: 'fact', text: 'Seat counts are due Nov 1', project: 'Q4 Launch' },
      {
        op: 'add',
        kind: 'idea',
        text: 'A partner directory',
        person: 'Lena Fischer',
        back: 'after the renewal',
      },
    ])
    assert.equal(
      r.results[0]!.items[0]!.line,
      `- [ ] Call [[Dana Whitfield]] about the discount [src:: cv ${TODAY}]`,
    )
    assert.equal(
      r.results[1]!.items[0]!.line,
      `- Seat counts are due Nov 1 for [[Q4 Launch]] [src:: cv ${TODAY}]`,
    )
    assert.equal(
      r.results[2]!.items[0]!.line,
      `- A partner directory with [[Lena Fischer]] [back:: after the renewal] [src:: cv ${TODAY}]`,
    )
  })

  it('puts the person first on a waiting item, with since defaulting to today', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      {
        op: 'add',
        kind: 'waiting',
        text: 'Priya: the SSO rollout plan',
        person: 'Priya Natarajan',
      },
    ])
    assert.equal(
      r.results[0]!.items[0]!.line,
      `- [ ] [[Priya Natarajan]]: the SSO rollout plan [since:: ${TODAY}] [src:: cv ${TODAY}]`,
    )
  })

  it('writes links, catch-up lines and quotes', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      {
        op: 'add',
        kind: 'link',
        text: 'Launch checklist',
        url: 'https://docs.example.com/launch',
        project: 'Q4 Launch',
      },
      {
        op: 'add',
        kind: 'catch_up',
        text: 'Lena asked about the credit',
        person: 'Lena Fischer',
        fields: { kind: 'reply', raised: 0 },
      },
      {
        op: 'add',
        kind: 'idea',
        text: 'Annual plans for big teams',
        quote: 'Dana wants 15% off.\nThink about it.',
      },
    ])
    assert.match(
      await read('links.md'),
      /- \[Launch checklist\]\(https:\/\/docs\.example\.com\/launch\) for \[\[Q4 Launch\]\] \[src:: cv 2026-10-17\]\n$/,
    )
    const catchUp = (await read('catch-up.md')).split('\n')
    const at = catchUp.indexOf('## Needs your reply')
    assert.equal(
      catchUp[at + 2],
      `- [[Lena Fischer]] asked about the credit [kind:: reply] [since:: ${TODAY}] [raised:: 0] [src:: cv ${TODAY}]`,
    )
    assert.match(
      await read('ideas.md'),
      /Annual plans for big teams \[src:: cv 2026-10-17\]\n  > Dana wants 15% off\.\n  > Think about it\.\n$/,
    )
  })

  it('returns the existing item instead of adding a duplicate', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'add',
        kind: 'action',
        text: 'Reply to Jordan Kim with Q3 churn numbers',
        person: 'Jordan Kim',
      },
    ])
    assert.equal(r.results[0]!.status, 'duplicate')
    assert.equal(r.change_id, null)
    assert.equal(await read('actions.md'), original.get('actions.md'))
    assert.equal(r.results[0]!.warnings[0]!.code, 'duplicate')
  })

  it('warns about likely duplicates but still adds', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      {
        op: 'add',
        kind: 'action',
        text: 'Send the v3 pricing deck to Dana',
        person: 'Dana Whitfield',
      },
    ])
    assert.equal(r.results[0]!.status, 'added')
    assert.equal(r.results[0]!.warnings[0]!.code, 'likely_duplicate')
  })

  it('refuses a close name with the closest matches, and accepts it once confirmed', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'add', kind: 'action', text: 'Email Dana', person: 'Dana Whitfeld' }]),
    )
    assert.equal(e.code, 'close_name')
    assert.equal(e.operation, 0)
    assert.match(e.message, /Dana Whitfield/)
    const ok = await apply(
      [{ op: 'add', kind: 'action', text: 'Email Dana', person: 'Dana Whitfeld' }],
      {
        confirm_new_names: ['Dana Whitfeld'],
      },
    )
    assert.deepEqual(ok.new_names, ['Dana Whitfeld'])
  })

  it('reports a genuinely new name', async () => {
    const { apply } = await fixtureService()
    const r = await apply([
      { op: 'add', kind: 'action', text: 'Intro call with Theo Brandt', person: 'Theo Brandt' },
    ])
    assert.deepEqual(r.new_names, ['Theo Brandt'])
    assert.equal(r.results[0]!.warnings[0]!.code, 'new_name')
  })

  it('refuses hand-formatted fields, bad dates, secrets and missing parts', async () => {
    const { apply } = await fixtureService()
    for (const [op, code, pattern] of [
      [
        { op: 'add', kind: 'action', text: 'Do it [due:: 2026-10-20]' },
        'invalid_value',
        /separate values/,
      ],
      [{ op: 'add', kind: 'action', text: 'Do it', due: 'Friday' }, 'invalid_value', /YYYY-MM-DD/],
      [
        { op: 'add', kind: 'fact', text: 'The office wifi password is hunter22' },
        'secret',
        /password/,
      ],
      [{ op: 'add', kind: 'waiting', text: 'The estimate' }, 'invalid_value', /person/],
      [{ op: 'add', kind: 'link', text: 'A form' }, 'invalid_value', /url/],
      [{ op: 'add', kind: 'action', text: 'x', src: 'Carbon Voice' }, 'invalid_value', /src/],
      [{ op: 'add', kind: 'action', text: 'Two\nlines' }, 'invalid_value', /one line/],
      [
        { op: 'add', kind: 'action', text: 'x', fields: { done: '2026-10-01' } },
        'invalid_value',
        /complete/,
      ],
    ] as const) {
      const e = await refusal(apply([op]))
      assert.equal(e.code, code, JSON.stringify(op))
      assert.match(e.message, pattern)
    }
  })

  it('refuses unknown fields and operations with a fix', async () => {
    const { apply } = await fixtureService()
    let e = await refusal(apply([{ op: 'add', kind: 'action', text: 'x', due_date: '2026-10-20' }]))
    assert.equal(e.code, 'invalid_request')
    assert.match(e.message, /Operation 0.*unknown field "due_date"/)
    e = await refusal(apply([{ op: 'delete', id: 'abc123' }]))
    assert.match(e.message, /unknown operation/)
  })

  it('never repeats the secret in the refusal', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(
      apply([{ op: 'add', kind: 'fact', text: 'AKIAABCDEFGHIJKLMNOP is the key' }]),
    )
    assert.ok(!e.message.includes('AKIA'))
  })
})

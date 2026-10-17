import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { itemId } from '../../src/format/ids.ts'
import { fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, TODAY, fixtureService } from '../helpers/service.ts'

const original = fixtureNotes()
const lineOf = (path: string, start: string) =>
  original
    .get(path)!
    .split('\n')
    .find((l) => l.includes(start))!
const idOf = (path: string, start: string) => itemId(path, lineOf(path, start), 0)

describe('note', () => {
  it('creates a person note with front matter and lines', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'note',
        type: 'person',
        name: 'Sam Okafor',
        front_matter: { role: 'Recruiter', last_talked: TODAY },
        append: ['Runs the Senior PM search'],
      },
    ])
    assert.equal(r.results[0]!.status, 'created')
    assert.equal(
      await read('people/Sam Okafor.md'),
      `---\nrole: Recruiter\nlast_talked: ${TODAY}\n---\n# Sam Okafor\n\n- Runs the Senior PM search [src:: cv ${TODAY}]\n`,
    )
  })

  it('creates a project with status active by default', async () => {
    const { apply, read } = await fixtureService()
    await apply([{ op: 'note', type: 'project', name: 'Referral program' }])
    assert.equal(
      await read('projects/Referral program.md'),
      '---\nstatus: active\n---\n# Referral program\n',
    )
  })

  it('sets front matter on an existing note, touching only that line', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      {
        op: 'note',
        type: 'person',
        name: 'Dana Whitfield',
        front_matter: { last_talked: TODAY, nickname: null },
      },
    ])
    assert.equal(
      await read('people/Dana Whitfield.md'),
      original
        .get('people/Dana Whitfield.md')!
        .replace('last_talked: 2026-10-13', `last_talked: ${TODAY}`),
    )
  })

  it('adds front matter to a note without any, and appends to a named section', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'note', type: 'area', name: 'Key customers', front_matter: { owner: 'Alex' } },
      {
        op: 'note',
        file: 'about-me.md',
        section: 'Learned',
        append: [{ text: 'Prefers calls after 11', src: 'cal' }],
      },
      {
        op: 'note',
        type: 'project',
        name: 'Q4 Launch',
        section: 'Risks',
        append: ['Stripe invoice change'],
      },
    ])
    assert.ok(
      (await read('areas/Key customers.md')).startsWith('---\nowner: Alex\n---\n# Key customers\n'),
    )
    assert.ok(
      (await read('about-me.md')).endsWith(
        `8:30am [src:: cv 2026-10-10]\n- Prefers calls after 11 [src:: cal ${TODAY}]\n`,
      ),
    )
    assert.ok(
      (await read('projects/Q4 Launch.md')).endsWith(
        `\`\`\`\n\n## Risks\n- Stripe invoice change [src:: cv ${TODAY}]\n`,
      ),
    )
  })

  it('checks names before creating notes, and front matter values', async () => {
    const { apply } = await fixtureService()
    assert.equal(
      (await refusal(apply([{ op: 'note', type: 'person', name: 'Priya Natarajen' }]))).code,
      'close_name',
    )
    assert.equal(
      (await refusal(apply([{ op: 'note', type: 'person', name: 'A/B' }]))).code,
      'invalid_value',
    )
    assert.match(
      (
        await refusal(
          apply([
            {
              op: 'note',
              type: 'project',
              name: 'Q4 Launch',
              front_matter: { status: 'finished' },
            },
          ]),
        )
      ).message,
      /active, paused, done, dropped/,
    )
    assert.match(
      (await refusal(apply([{ op: 'note', file: 'my-rules.md', append: ['x'] }]))).message,
      /rule operation/,
    )
  })
})

describe('merge', () => {
  it('keeps the first item with every src and archives the others', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'add',
        kind: 'action',
        text: 'Send Dana the v3 pricing deck',
        person: 'Dana Whitfield',
        src: 'slack 2026-10-16',
        quote: 'Dana pinged again',
      },
      {
        op: 'merge',
        items: [
          { id: idOf('actions.md', 'Send the v3 pricing deck') },
          { match: 'Send Dana Whitfield the v3 pricing deck', file: 'actions.md' },
        ],
      },
    ])
    assert.equal(r.results[1]!.status, 'merged')
    const a = await read('actions.md')
    assert.ok(
      a.includes(
        '- [ ] Send the v3 pricing deck to [[Dana Whitfield]] for [[Q4 Launch]] [due:: 2026-10-16] [src:: cv 2026-10-13] [src:: slack 2026-10-16]\n  > Dana pinged again\n',
      ),
    )
    assert.ok(!a.includes('Send [[Dana Whitfield]] the v3'))
    assert.match(
      await read('archive/2026-10.md'),
      /Send \[\[Dana Whitfield\]\] the v3 pricing deck \[archived:: 2026-10-17\] \[why:: merged\] \[from:: actions\]/,
    )
  })
})

describe('promote', () => {
  it('creates the project and moves the idea into its Notes', async () => {
    const { apply, read } = await fixtureService()
    const r = await apply([
      {
        op: 'promote',
        id: idOf('ideas.md', 'A referral program'),
        project: 'Referral program',
        front_matter: { area: 'Product' },
      },
    ])
    assert.equal(r.results[0]!.items[0]!.file, 'projects/Referral program.md')
    assert.equal(
      await read('projects/Referral program.md'),
      `---\nstatus: active\narea: Product\n---\n# Referral program\n\n## Notes\n${lineOf('ideas.md', 'A referral program')}\n  > Remind me about the free-seat referral thing once pricing's done. I think it could beat paid ads.\n`,
    )
    assert.ok(!(await read('ideas.md')).includes('referral'))
    assert.ok(r.new_names.includes('Referral program'))
  })
})

describe('set_focus', () => {
  it("replaces focus and this week's dates, and adds a suggestion", async () => {
    const { apply, read } = await fixtureService()
    await apply([
      {
        op: 'set_focus',
        focus: ['Close the Acme renewal', { text: 'Ship SSO', person: 'Priya Natarajan' }],
        this_week: [
          { date: '2026-10-22', text: 'SSO launch' },
          { date: '2026-10-20', text: 'Board prep with Jordan', person: 'Jordan Kim' },
        ],
        suggest: 'Make the Stripe invoice change a project?',
      },
    ])
    assert.equal(
      await read('now.md'),
      `# Now\n\n## Focus\n- Close the Acme renewal\n- Ship SSO with [[Priya Natarajan]]\n\n## This week\n- 2026-10-20 Board prep with [[Jordan Kim]]\n- 2026-10-22 SSO launch\n\n## Suggested moves\n${lineOf('now.md', 'referral idea')}\n${lineOf('now.md', 'Stripe invoice under')}\n- Make the Stripe invoice change a project? [src:: cv ${TODAY}]\n`,
    )
  })

  it('allows at most three focus lines', async () => {
    const { apply } = await fixtureService()
    const e = await refusal(apply([{ op: 'set_focus', focus: ['a', 'b', 'c', 'd'] }]))
    assert.equal(e.code, 'invalid_request')
  })
})

describe('rule', () => {
  it('adds a rule, changes a setting, and edits a rule', async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'rule', text: 'Never schedule anything before 9', section: 'My rules' },
      { op: 'rule', settings: { stale_days: 14 } },
      { op: 'rule', match: 'Nudge me at most twice', text: 'Nudge me at most once a day' },
    ])
    const r = await read('my-rules.md')
    assert.ok(r.includes('stale_days: 14\n'))
    assert.ok(
      r.includes(
        `- Nudge me at most once a day [replaces:: nudges] [src:: cv 2026-10-08]\n- Never schedule anything before 9 [src:: cv ${TODAY}]\n\n## Where things go`,
      ),
    )
  })

  it('needs the rules:write scope, for rule and for any edit of my-rules.md', async () => {
    const { apply } = await fixtureService()
    const limited = { ...AGENT, scopes: ['notebook:read', 'notebook:write'] }
    assert.equal((await refusal(apply([{ op: 'rule', text: 'x' }], {}, limited))).code, 'forbidden')
    assert.equal(
      (
        await refusal(
          apply([{ op: 'update', match: 'Drafts should sound like me', text: 'y' }], {}, limited),
        )
      ).code,
      'forbidden',
    )
    const ok = await apply(
      [{ op: 'rule', text: 'x rule' }],
      {},
      { ...limited, scopes: [...limited.scopes, 'rules:write'] },
    )
    assert.equal(ok.results[0]!.status, 'updated')
  })

  it('validates settings', async () => {
    const { apply } = await fixtureService()
    assert.match(
      (await refusal(apply([{ op: 'rule', settings: { timezone: 'Mars/Olympus' } }]))).message,
      /IANA/,
    )
    assert.match(
      (await refusal(apply([{ op: 'rule', settings: { meeting_prep: 'always' } }]))).message,
      /offer, auto or off/,
    )
  })
})

describe('log', () => {
  it("adds a line to today's log with the time and who wrote it, and no change line", async () => {
    const { apply, read } = await fixtureService()
    await apply([
      { op: 'log', text: 'Talked through the pricing with Dana', person: 'Dana Whitfield' },
    ])
    assert.equal(
      await read(`log/${TODAY}.md`),
      `# ${TODAY}\n\n- 10:05 Talked through the pricing with [[Dana Whitfield]] [by:: claude-desktop for Alex]\n`,
    )
  })
})

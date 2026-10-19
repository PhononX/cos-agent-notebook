import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, NB, TODAY, fixtureService } from '../helpers/service.ts'

const original = fixtureNotes()

describe('write_brief', () => {
  it('starts brief.md again on a new day, with sections and numbered follow-ups', async () => {
    const { service, read, history } = await fixtureService()
    const r = await service.writeBrief(
      NB,
      {
        name: 'Morning brief',
        sent: '07:01',
        sections: [
          { title: 'Focus', lines: ['Close the Acme renewal'] },
          {
            title: 'Meetings',
            lines: [
              {
                text: '09:30 Pricing review with Dana',
                person: 'Dana Whitfield',
                fields: { prep: 'ready' },
              },
            ],
          },
        ],
        follow_ups: [
          {
            text: 'Send the deck to Dana',
            person: 'Dana Whitfield',
            src: 'cv',
            draft: 'Dana, here is the deck.',
          },
        ],
      },
      AGENT,
    )
    assert.equal(
      await read('brief.md'),
      [
        '---',
        `date: ${TODAY}`,
        '---',
        '# Briefs for Saturday, October 17',
        '',
        '## Morning brief [sent:: 07:01]',
        '',
        '### Focus',
        '- Close the Acme renewal',
        '',
        '### Meetings',
        '- 09:30 Pricing review with [[Dana Whitfield]] [prep:: ready]',
        '',
        '### Follow-ups',
        `1. Send the deck to [[Dana Whitfield]] [src:: cv ${TODAY}]`,
        '   > Dana, here is the deck.',
        '',
      ].join('\n'),
    )
    assert.ok(r.change_id)
    assert.equal(history.commitsOf(NB).at(-1)!.summary, 'Wrote the Morning brief in brief.md')
    assert.equal(r.results[0]!.items.length, 3)
  })

  it('adds a second brief the same day, and replaces one written again under its name', async () => {
    const { service, read } = await fixtureService()
    await service.writeBrief(
      NB,
      { name: 'Morning brief', sections: [{ title: 'Focus', lines: ['A'] }] },
      AGENT,
    )
    await service.writeBrief(
      NB,
      { name: 'Midday check-in', sections: [{ title: 'Catch up', lines: ['B'] }] },
      AGENT,
    )
    await service.writeBrief(
      NB,
      { name: 'Morning brief', sections: [{ title: 'Focus', lines: ['A, revised'] }] },
      AGENT,
    )
    const brief = await read('brief.md')
    assert.match(
      brief,
      /## Morning brief \[sent:: 10:05\]\n\n### Focus\n- A, revised\n\n## Midday check-in \[sent:: 10:05\]\n\n### Catch up\n- B\n$/,
    )
    assert.equal((brief.match(/## Morning brief/g) ?? []).length, 1)
  })

  it('refuses an empty brief, and follow-ups passed as a section', async () => {
    const { service } = await fixtureService()
    assert.equal(
      (await refusal(service.writeBrief(NB, { name: 'Morning brief' }, AGENT))).code,
      'invalid_value',
    )
    const e = await refusal(
      service.writeBrief(
        NB,
        { name: 'X', sections: [{ title: 'Follow-ups', lines: ['a'] }] },
        AGENT,
      ),
    )
    assert.match(e.message, /follow_ups/)
  })
})

describe('update_catch_up', () => {
  const link = 'https://mail.example.com/thread/18c2f'

  it('raises a line mentioned again, by its thread link', async () => {
    const { service, read } = await fixtureService()
    await service.updateCatchUp(
      NB,
      {
        items: [
          {
            link,
            source: 'gmail',
            text: 'Jordan asked again for the Q3 churn numbers',
            kind: 'reply',
            person: 'Jordan Kim',
          },
        ],
      },
      AGENT,
    )
    const c = await read('catch-up.md')
    assert.ok(
      c.includes(
        `- [[Jordan Kim]] asked again for the Q3 churn numbers [kind:: reply] [since:: 2026-10-12] [raised:: 3] [src:: gmail 2026-10-12 ${link}]\n`,
      ),
    )
  })

  it('adds a new thread under its kind, and moves a line whose kind changed', async () => {
    const { service, read } = await fixtureService()
    await service.updateCatchUp(
      NB,
      {
        items: [
          {
            link: 'https://chat.example.com/t/9',
            source: 'slack',
            text: 'Priya asked about SSO timing',
            kind: 'reply',
            person: 'Priya Natarajan',
          },
          {
            link: 'https://mail.example.com/thread/19a07',
            source: 'gmail',
            text: 'Lena wants an answer on seat counts',
            kind: 'reply',
            person: 'Lena Fischer',
          },
        ],
      },
      AGENT,
    )
    const c = (await read('catch-up.md')).split('\n')
    const reply = c.indexOf('## Needs your reply')
    const missed = c.indexOf('## You may have missed')
    const between = c.slice(reply, missed).join('\n')
    assert.match(
      between,
      /\[\[Priya Natarajan\]\] asked about SSO timing \[kind:: reply\] \[since:: 2026-10-17\] \[raised:: 1\] \[src:: slack 2026-10-17 https:\/\/chat\.example\.com\/t\/9\]/,
    )
    assert.match(
      between,
      /\[\[Lena Fischer\]\] wants an answer on seat counts \[kind:: reply\] \[since:: 2026-10-14\] \[raised:: 2\]/,
    )
    assert.ok(!c.slice(missed).join('\n').includes('seat counts'))
  })

  it('closes a line by link, archiving it with the reason', async () => {
    const { service, read } = await fixtureService()
    await service.updateCatchUp(NB, { close: [{ link, why: 'replied' }] }, AGENT)
    assert.ok(!(await read('catch-up.md')).includes('Q3 churn'))
    assert.match(
      await read('archive/2026-10.md'),
      /Q3 churn numbers \[kind:: reply\] \[since:: 2026-10-12\] \[raised:: 2\] \[archived:: 2026-10-17\] \[why:: replied\] \[from:: catch-up\]/,
    )
    assert.equal(
      (
        await refusal(
          service.updateCatchUp(
            NB,
            { close: [{ link: 'https://x.example.com/none', why: 'x' }] },
            AGENT,
          ),
        )
      ).code,
      'not_found',
    )
  })
})

describe('save_draft', () => {
  it('creates a draft with version 1', async () => {
    const { service, read } = await fixtureService()
    await service.saveDraft(
      NB,
      {
        name: 'Renewal email to Lena',
        draft: 'Lena,\n\nHere is the offer.',
        change: 'first draft',
        kind: 'email',
        for: 'Lena Fischer',
        horizon: 'soon',
        notes: ['Offer one month of credit'],
      },
      AGENT,
    )
    assert.equal(
      await read('drafts/Renewal email to Lena.md'),
      [
        '---',
        'kind: email',
        'horizon: soon',
        'for: "[[Lena Fischer]]"',
        'status: draft',
        'version: 1',
        `touched: ${TODAY}`,
        '---',
        '# Renewal email to Lena',
        '',
        '## Draft',
        'Lena,',
        '',
        'Here is the offer.',
        '',
        '## Notes',
        `- Offer one month of credit [src:: cv ${TODAY}]`,
        '',
        '## History',
        `- v1 ${TODAY} first draft [src:: cv ${TODAY}]`,
        '',
      ].join('\n'),
    )
  })

  it('saves a new version, keeping the previous one in drafts/.history', async () => {
    const { service, read, store } = await fixtureService()
    const before = original.get('drafts/Board narrative.md')!
    const r = await service.saveDraft(
      NB,
      {
        name: 'Board narrative',
        draft: 'Q3 in one line: churn fell.',
        change: 'one-line opening',
        status: 'ready',
      },
      AGENT,
    )
    assert.equal(await store.read(NB, 'drafts/.history/Board narrative/v2.md'), before)
    const after = await read('drafts/Board narrative.md')
    assert.match(after, /status: ready\n/)
    assert.match(after, /version: 3\n/)
    assert.match(after, /## Draft\nQ3 in one line: churn fell\.\n\n## Notes/)
    assert.match(
      after,
      /## History\n- v3 2026-10-17 one-line opening \[src:: cv 2026-10-17\]\n- v2 2026-10-15/,
    )
    assert.ok(
      r.files.some(
        (f) => f.path === 'drafts/.history/Board narrative/v2.md' && f.status === 'created',
      ),
    )
  })

  it('refuses headings that would break the note, and secrets', async () => {
    const { service } = await fixtureService()
    const e = await refusal(
      service.saveDraft(NB, { name: 'X', draft: '## Section', change: 'c' }, AGENT),
    )
    assert.match(e.message, /### for headings/)
    const s = await refusal(
      service.saveDraft(NB, { name: 'X', draft: 'the password is hunter22', change: 'c' }, AGENT),
    )
    assert.equal(s.code, 'secret')
  })
})

describe('clear_nudges', () => {
  it('removes raised reminders by id, phrase, or all of them', async () => {
    const { service, read, apply } = await fixtureService()
    const items = await service.listItems(NB, { file: 'nudges.md' })
    await service.clearNudges(NB, { ids: [items[0]!.id] }, AGENT)
    assert.ok(!(await read('nudges.md')).includes('waiting 3 days'))
    await service.clearNudges(NB, { match: 'referral program' }, AGENT)
    assert.ok(!(await read('nudges.md')).includes('referral'))
    await service.clearNudges(NB, { all: true }, AGENT)
    assert.equal(await read('nudges.md'), '# Nudges\n\n')
    void apply
  })
})

describe('write tools share apply_changes guarantees', () => {
  it('support dry runs and idempotency keys', async () => {
    const { service, read, history } = await fixtureService()
    const dry = await service.clearNudges(NB, { all: true, dry_run: true }, AGENT)
    assert.equal(dry.change_id, null)
    assert.equal(await read('nudges.md'), original.get('nudges.md'))
    const input = {
      name: 'Morning brief',
      sections: [{ title: 'Focus', lines: ['A'] }],
      idempotency_key: 'brief-key-0001',
    }
    const first = await service.writeBrief(NB, input, AGENT)
    const again = await service.writeBrief(NB, input, AGENT)
    assert.equal(again.replayed, true)
    assert.equal(again.change_id, first.change_id)
    assert.equal(history.commitsOf(NB).length, 1)
    const e = await refusal(service.writeBrief(NB, { ...input, unknown: 1 }, AGENT))
    assert.equal(e.code, 'invalid_request')
  })
})

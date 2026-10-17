import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MemoryHistory,
  MemoryIdempotency,
  MemoryLock,
  MemoryStore,
} from '../../src/adapters/memory/index.ts'
import {
  checkRef,
  formatRef,
  notebookKey,
  parseRef,
  personalNotebook,
  workspaceNotebook,
} from '../../src/domain/notebook-ref.ts'
import { NotebookService } from '../../src/domain/service.ts'
import { parseNote } from '../../src/format/note.ts'
import { parseSameAs, renderSameAs } from '../../src/format/values.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, NOW } from '../helpers/service.ts'

const personal = personalNotebook('alex')
const work = workspaceNotebook('northwind', 'alex')

async function twoNotebooks() {
  const store = new MemoryStore()
  const history = new MemoryHistory(store)
  const service = new NotebookService({
    store,
    history,
    lock: new MemoryLock(),
    idempotency: new MemoryIdempotency(),
    clock: { now: () => NOW },
    defaultTimezone: 'UTC',
  })
  await service.init(personal, { actor: AGENT })
  await service.init(work, { actor: AGENT })
  return { store, history, service }
}

describe('notebook references', () => {
  it('format, parse and key personal and workspace notebooks apart', () => {
    assert.equal(formatRef(personal), 'personal:alex:default')
    assert.equal(formatRef(work), 'workspace:northwind:alex')
    assert.deepEqual(parseRef('workspace:northwind:alex'), work)
    assert.equal(notebookKey(personal), 'personal/alex/default')
    assert.equal(notebookKey(work), 'workspaces/northwind/alex')
    // The same names in different spaces are different notebooks.
    assert.notEqual(notebookKey(personalNotebook('northwind', 'alex')), notebookKey(work))
  })

  it('refuses anything that could escape its space', () => {
    for (const bad of [
      'personal:alex',
      'personal:../x:default',
      'personal:Alex:default',
      'team:northwind:alex',
      'workspace:north/wind:alex',
      'workspace:northwind:alex:extra',
      '',
    ]) {
      assert.throws(() => parseRef(bad), /notebook is named by its space/, bad)
    }
    assert.throws(() => checkRef({ space: { kind: 'personal' }, id: 'default' }))
    assert.throws(() => checkRef('personal:alex:default'))
  })
})

describe('personal and workspace notebooks', () => {
  it('keep their files and history apart', async () => {
    const { store, history, service } = await twoNotebooks()
    await service.applyChanges(
      work,
      { operations: [{ op: 'add', kind: 'action', text: 'Send the Q4 deck' }] },
      AGENT,
    )
    assert.match((await store.read(work, 'actions.md'))!, /Send the Q4 deck/)
    assert.doesNotMatch((await store.read(personal, 'actions.md'))!, /Send the Q4 deck/)
    assert.equal(history.commitsOf(work).length, 2)
    assert.equal(history.commitsOf(personal).length, 1)
  })

  it('treat the same idempotency key in each notebook as unrelated', async () => {
    const { service } = await twoNotebooks()
    const req = (text: string) => ({
      operations: [{ op: 'add', kind: 'inbox', text }],
      idempotency_key: 'turn-0000001',
    })
    const a = await service.applyChanges(work, req('Work thing'), AGENT)
    const b = await service.applyChanges(personal, req('Dentist on Friday'), AGENT)
    assert.equal(b.replayed, false)
    assert.notEqual(a.change_id, b.change_id)
  })

  it("never undo or address one notebook's changes and items from another", async () => {
    const { service } = await twoNotebooks()
    const r = await service.applyChanges(
      work,
      { operations: [{ op: 'add', kind: 'action', text: 'Review the hiring plan' }] },
      AGENT,
    )
    assert.equal((await refusal(service.undo(personal, r.change_id!, AGENT))).code, 'not_found')
    const id = r.results[0]!.items[0]!.id!
    const e = await refusal(
      service.applyChanges(personal, { operations: [{ op: 'complete', id }] }, AGENT),
    )
    assert.equal(e.code, 'not_found')
    assert.equal((await service.undo(work, r.change_id!, AGENT)).undone, r.change_id)
  })

  it('give a person a separate notebook in each workspace', async () => {
    const { store, service } = await twoNotebooks()
    const other = workspaceNotebook('fernhill', 'alex')
    await service.init(other, { actor: AGENT })
    await service.applyChanges(
      other,
      { operations: [{ op: 'add', kind: 'action', text: 'Draft the Fernhill board memo' }] },
      AGENT,
    )
    assert.match((await store.read(other, 'actions.md'))!, /Fernhill board memo/)
    for (const nb of [work, personal]) {
      assert.doesNotMatch((await store.read(nb, 'actions.md'))!, /Fernhill/)
    }
    assert.deepEqual([...store.notebooks.keys()].sort(), [
      'personal/alex/default',
      'workspaces/fernhill/alex',
      'workspaces/northwind/alex',
    ])
  })

  it('check names only against the notebook being written', async () => {
    const { service } = await twoNotebooks()
    await service.applyChanges(
      work,
      { operations: [{ op: 'note', type: 'person', name: 'Dana Whitfield' }] },
      AGENT,
    )
    // A close name in the personal notebook is new there: work people don't leak into it.
    const r = await service.applyChanges(
      personal,
      { operations: [{ op: 'add', kind: 'action', text: 'Call Dana', person: 'Dana Whitfeld' }] },
      AGENT,
    )
    assert.deepEqual(r.new_names, ['Dana Whitfeld'])
  })
})

describe('the same person across spaces', () => {
  it('parse and render same_as links, and check them in person notes only', () => {
    const { links, invalid } = parseSameAs(
      'workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D. Whitfield',
    )
    assert.deepEqual(invalid, [])
    assert.deepEqual(links, [
      { notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' },
      { notebook: 'workspace:fernhill:alex', name: 'D. Whitfield' },
    ])
    assert.equal(
      renderSameAs(links),
      'workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D. Whitfield',
    )
    for (const bad of [
      'Dana Whitfield',
      'workspace:northwind/Dana',
      'workspace:northwind:alex/a:b',
      'team:x:y/Dana',
      'personal:bob:default/Sam',
    ]) {
      assert.deepEqual(parseSameAs(bad), { links: [], invalid: [bad] }, bad)
    }
    // A broken part never hides the good ones.
    assert.deepEqual(parseSameAs('workspace:northwind:alex/Dana | workspace:fernhill:alex/D:'), {
      links: [{ notebook: 'workspace:northwind:alex', name: 'Dana' }],
      invalid: ['workspace:fernhill:alex/D:'],
    })
    const stray = parseNote(
      'projects/Q4 Launch.md',
      '---\nsame_as: workspace:northwind:alex/Q4\n---\n# Q4\n',
    )
    assert.match(stray.problems[0]!.message, /only for person notes/)
  })

  it('a personal note can be a stub that points to the work note', async () => {
    const { store, service } = await twoNotebooks()
    await service.applyChanges(
      work,
      {
        operations: [
          {
            op: 'note',
            type: 'person',
            name: 'Dana Whitfield',
            front_matter: { role: 'Head of Sales' },
          },
        ],
      },
      AGENT,
    )
    await service.applyChanges(
      personal,
      {
        operations: [
          {
            op: 'note',
            type: 'person',
            name: 'Dana Whitfield',
            same_as: [{ notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' }],
          },
        ],
      },
      AGENT,
    )
    assert.equal(
      await store.read(personal, 'people/Dana Whitfield.md'),
      '---\nsame_as: workspace:northwind:alex/Dana Whitfield\n---\n# Dana Whitfield\n',
    )
    // A second workspace adds to the links instead of replacing them, and repeats are ignored.
    await service.init(workspaceNotebook('fernhill', 'alex'), { actor: AGENT })
    await service.applyChanges(
      personal,
      {
        operations: [
          {
            op: 'note',
            type: 'person',
            name: 'Dana Whitfield',
            same_as: [
              { notebook: 'workspace:fernhill:alex', name: 'D. Whitfield' },
              { notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' },
            ],
          },
        ],
      },
      AGENT,
    )
    const note = await service.readNote(personal, 'people/Dana Whitfield.md')
    assert.deepEqual(note.same_as, [
      { notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' },
      { notebook: 'workspace:fernhill:alex', name: 'D. Whitfield' },
    ])
    // From the work side, the agent finds the person's own note by reading the personal notebook.
    // Each result carries only the links to the notebook asked about, never the other spaces.
    const found = await service.findLinkedPeople(personal, {
      notebook: 'workspace:northwind:alex',
      name: '[[Dana Whitfield]] ',
    })
    assert.deepEqual(found, [
      {
        path: 'people/Dana Whitfield.md',
        name: 'Dana Whitfield',
        links: [{ notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' }],
      },
    ])
    assert.deepEqual(
      await service.findLinkedPeople(personal, {
        notebook: 'workspace:northwind:alex',
        name: 'Sam Okafor',
      }),
      [],
    )
  })

  it('are never written in a workspace notebook, and only point to work notebooks', async () => {
    const { service } = await twoNotebooks()
    const link = [{ notebook: 'personal:alex:default', name: 'Dana' }]
    let e = await refusal(
      service.applyChanges(
        work,
        { operations: [{ op: 'note', type: 'person', name: 'Dana Whitfield', same_as: link }] },
        AGENT,
      ),
    )
    assert.match(e.message, /only in the person's personal notebook/)
    e = await refusal(
      service.applyChanges(
        work,
        {
          operations: [
            {
              op: 'note',
              type: 'person',
              name: 'Dana Whitfield',
              front_matter: { same_as: 'workspace:fernhill:alex/Dana' },
            },
          ],
        },
        AGENT,
      ),
    )
    assert.match(e.message, /only in the person's personal notebook/)
    e = await refusal(
      service.applyChanges(
        personal,
        { operations: [{ op: 'note', type: 'person', name: 'Dana Whitfield', same_as: link }] },
        AGENT,
      ),
    )
    assert.match(e.message, /isn't a work notebook/)
    e = await refusal(
      service.applyChanges(
        personal,
        {
          operations: [
            {
              op: 'note',
              type: 'project',
              name: 'House move',
              same_as: [{ notebook: 'workspace:northwind:alex', name: 'Relocation' }],
            },
          ],
        },
        AGENT,
      ),
    )
    assert.match(e.message, /person notes/)
    await assert.rejects(
      service.findLinkedPeople(work, { notebook: 'workspace:northwind:alex' }),
      /personal notebook/,
    )
    const bad = await refusal(service.findLinkedPeople(personal, { notebook: 'northwind' }))
    assert.equal(bad.code, 'invalid_value')
  })

  it('keep links a hand-edited line holds, refusing to overwrite a line they cannot read', async () => {
    const { store, service } = await twoNotebooks()
    await store.write(personal, [
      {
        path: 'people/Dana Whitfield.md',
        content:
          '---\nsame_as: workspace:northwind:alex/Dana Whitfield, workspace:fernhill:alex/D. Whitfield\n---\n# Dana Whitfield\n',
      },
    ])
    const e = await refusal(
      service.applyChanges(
        personal,
        {
          operations: [
            {
              op: 'note',
              type: 'person',
              name: 'Dana Whitfield',
              same_as: [{ notebook: 'workspace:acme:alex', name: 'Dana' }],
            },
          ],
        },
        AGENT,
      ),
    )
    assert.equal(e.code, 'invalid_value')
    assert.match(e.message, /aren't links/)
    assert.match((await store.read(personal, 'people/Dana Whitfield.md'))!, /, workspace:fernhill/)
    // readNote still offers the links it can read, and reports the problem.
    await store.write(personal, [
      {
        path: 'people/Dana Whitfield.md',
        content:
          '---\nsame_as: workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D:\n---\n# Dana Whitfield\n',
      },
    ])
    const note = await service.readNote(personal, 'people/Dana Whitfield.md')
    assert.deepEqual(note.same_as, [
      { notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' },
    ])
    assert.match(note.problems[0]!.message, /isn't a link/)
    assert.equal(
      (await service.findLinkedPeople(personal, { notebook: 'workspace:northwind:alex' })).length,
      1,
    )
  })

  it('check links the same way whether they come as same_as or front_matter', async () => {
    const { service } = await twoNotebooks()
    for (const value of ['personal:bob:default/Sam', 'personal:alex:default/Sam']) {
      const e = await refusal(
        service.applyChanges(
          personal,
          {
            operations: [
              { op: 'note', type: 'person', name: 'Sam Okafor', front_matter: { same_as: value } },
            ],
          },
          AGENT,
        ),
      )
      assert.equal(e.code, 'invalid_value', value)
    }
    const secret = await refusal(
      service.applyChanges(
        personal,
        {
          operations: [
            {
              op: 'note',
              type: 'person',
              name: 'Sam Okafor',
              same_as: [{ notebook: 'workspace:northwind:alex', name: `ghp_${'a'.repeat(36)}` }],
            },
          ],
        },
        AGENT,
      ),
    )
    assert.equal(secret.code, 'secret')
    const badRef = await refusal(
      service.applyChanges(
        personal,
        {
          operations: [
            {
              op: 'note',
              type: 'person',
              name: 'Sam Okafor',
              same_as: [{ notebook: 'workspace:Northwind:alex', name: 'Sam' }],
            },
          ],
        },
        AGENT,
      ),
    )
    assert.equal(badRef.code, 'invalid_value')
    assert.match(badRef.message, /same_as link 1/)
  })

  it('let a stray link in a work notebook be removed', async () => {
    const { store, service } = await twoNotebooks()
    await store.write(work, [
      { path: 'people/Lee.md', content: '---\nsame_as: workspace:fernhill:alex/Lee\n---\n# Lee\n' },
    ])
    await service.applyChanges(
      work,
      { operations: [{ op: 'note', file: 'people/Lee.md', front_matter: { same_as: null } }] },
      AGENT,
    )
    assert.equal(await store.read(work, 'people/Lee.md'), '# Lee\n')
  })

  it('report a new stub in file order, and change nothing when every link is already there', async () => {
    const { history, service } = await twoNotebooks()
    const op = {
      op: 'note',
      type: 'person',
      name: 'Dana Whitfield',
      same_as: [{ notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' }],
    }
    const first = await service.applyChanges(personal, { operations: [op] }, AGENT)
    assert.deepEqual(first.results[0]!.changes, [
      {
        file: 'people/Dana Whitfield.md',
        before: [],
        after: [
          '---',
          'same_as: workspace:northwind:alex/Dana Whitfield',
          '---',
          '# Dana Whitfield',
        ],
      },
    ])
    const commits = history.commitsOf(personal).length
    const again = await service.applyChanges(personal, { operations: [op] }, AGENT)
    assert.equal(again.results[0]!.status, 'unchanged')
    assert.equal(again.change_id, null)
    assert.equal(history.commitsOf(personal).length, commits)
  })

  it('allow at most 20 links on one person', async () => {
    const { service } = await twoNotebooks()
    const links = Array.from({ length: 21 }, (_, i) => ({
      notebook: `workspace:w${i}:alex`,
      name: 'Dana',
    }))
    const e = await refusal(
      service.applyChanges(
        personal,
        {
          operations: [
            { op: 'note', type: 'person', name: 'Dana Whitfield', same_as: links.slice(0, 10) },
            { op: 'note', type: 'person', name: 'Dana Whitfield', same_as: links.slice(10, 20) },
            { op: 'note', type: 'person', name: 'Dana Whitfield', same_as: links.slice(20) },
          ],
        },
        AGENT,
      ),
    )
    assert.match(e.message, /at most 20/)
  })
})

describe('unified reads', () => {
  it('list items from several notebooks as one view, each labelled with its notebook', async () => {
    const { service } = await twoNotebooks()
    await service.applyChanges(
      work,
      { operations: [{ op: 'add', kind: 'action', text: 'Ship SSO' }] },
      AGENT,
    )
    await service.applyChanges(
      personal,
      { operations: [{ op: 'add', kind: 'action', text: 'Book the dentist' }] },
      AGENT,
    )
    const all = (await service.listItems([personal, work], { file: 'actions.md' })).filter(
      (i) => i.done === false,
    )
    assert.deepEqual(
      all.map((i) => [i.notebook, i.text]),
      [
        ['personal:alex:default', 'Book the dentist'],
        ['workspace:northwind:alex', 'Ship SSO'],
      ],
    )
    // Narrowed to one notebook, only its items.
    const workOnly = await service.listItems([work], { file: 'actions.md' })
    assert.ok(workOnly.every((i) => i.notebook === 'workspace:northwind:alex'))
    assert.equal((await refusal(service.listItems([]))).code, 'invalid_request')
  })
})

describe('what lives only in the personal notebook', () => {
  it('a work notebook starts without about-me.md, with a workspace-only my-rules.md', async () => {
    const { store } = await twoNotebooks()
    assert.equal(await store.read(work, 'about-me.md'), null)
    assert.equal(
      await store.read(work, 'my-rules.md'),
      '---\ntimezone: UTC\n---\n# My rules for this workspace\n\n## Where things go\n\n## Important people\n\n## My tools\n',
    )
    assert.match(
      (await store.read(personal, 'my-rules.md'))!,
      /nudges_per_day: 3\nstale_days: 30\nmeeting_prep: offer/,
    )
    assert.match((await store.read(personal, 'about-me.md'))!, /^# About me/)
  })

  it("refuses the person's own files, settings and briefs in a work notebook", async () => {
    const { service } = await twoNotebooks()
    const tryWork = (op: Record<string, unknown>) =>
      refusal(service.applyChanges(work, { operations: [op] }, AGENT))
    assert.match(
      (
        await tryWork({
          op: 'note',
          file: 'about-me.md',
          section: 'Learned',
          append: ['Likes walks'],
        })
      ).message,
      /lives only in their personal notebook/,
    )
    assert.match(
      (await tryWork({ op: 'rule', settings: { nudges_per_day: 1 } })).message,
      /own preference/,
    )
    assert.match(
      (
        await tryWork({
          op: 'rule',
          section: 'My briefs',
          text: 'Morning brief',
          fields: { at: '07:00' },
        })
      ).message,
      /personal notebook/,
    )
    // What belongs to the workspace is fine.
    const ok = await service.applyChanges(
      work,
      {
        operations: [
          { op: 'rule', section: 'Where things go', text: 'Team tasks live in Linear' },
          { op: 'rule', settings: { timezone: 'Europe/Berlin' } },
        ],
      },
      AGENT,
    )
    assert.equal(ok.results[0]!.status, 'updated')
  })

  it('combines the profile: defaults, then personal, then the work notebook', async () => {
    const { service } = await twoNotebooks()
    await service.applyChanges(
      personal,
      {
        operations: [
          { op: 'rule', settings: { nudges_per_day: 1, timezone: 'America/New_York' } },
          { op: 'rule', text: 'No exclamation marks in anything I send' },
          { op: 'note', file: 'about-me.md', section: 'How I write', append: ['Short and direct'] },
        ],
      },
      AGENT,
    )
    await service.applyChanges(
      work,
      {
        operations: [
          { op: 'rule', section: 'My tools', text: 'Documents go in the Northwind shared drive' },
          { op: 'rule', settings: { timezone: 'Europe/Berlin' } },
        ],
      },
      AGENT,
    )
    const atHome = await service.profile(personal)
    assert.equal(atHome.timezone, 'America/New_York')
    assert.deepEqual(atHome.settings, { nudges_per_day: 1, stale_days: 30, meeting_prep: 'offer' })
    assert.deepEqual(
      atHome.about_me.map((l) => [l.section, l.text]),
      [['How I write', 'Short and direct']],
    )
    const atWork = await service.profile(personal, work)
    assert.equal(atWork.timezone, 'Europe/Berlin')
    assert.deepEqual(
      atWork.rules.map((r) => [r.notebook, r.section, r.text]),
      [
        ['personal:alex:default', 'My rules', 'No exclamation marks in anything I send'],
        ['workspace:northwind:alex', 'My tools', 'Documents go in the Northwind shared drive'],
      ],
    )
    await assert.rejects(service.profile(work), /personal notebook/)
    await assert.rejects(service.profile(personal, personal), /work notebook/)
  })
})

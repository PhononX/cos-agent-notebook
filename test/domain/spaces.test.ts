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
    const links = parseSameAs(
      'workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D. Whitfield',
    )
    assert.deepEqual(links, [
      { notebook: 'workspace:northwind:alex', name: 'Dana Whitfield' },
      { notebook: 'workspace:fernhill:alex', name: 'D. Whitfield' },
    ])
    assert.equal(
      renderSameAs(links!),
      'workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D. Whitfield',
    )
    for (const bad of [
      'Dana Whitfield',
      'workspace:northwind/Dana',
      'workspace:northwind:alex/a:b',
      'team:x:y/Dana',
    ]) {
      assert.equal(parseSameAs(bad), null, bad)
    }
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
    const found = await service.findLinkedPeople(personal, {
      notebook: work,
      name: 'Dana Whitfield',
    })
    assert.deepEqual(
      found.map((f) => f.path),
      ['people/Dana Whitfield.md'],
    )
    assert.deepEqual(
      await service.findLinkedPeople(personal, { notebook: work, name: 'Sam Okafor' }),
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
    assert.match(e.message, /isn't a workspace notebook/)
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
    await assert.rejects(service.findLinkedPeople(work, { notebook: work }), /personal notebook/)
  })
})

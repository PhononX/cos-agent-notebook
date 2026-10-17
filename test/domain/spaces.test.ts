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

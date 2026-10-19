import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createLocalService,
  LOCAL_NOTEBOOK as NB,
  localDirFor,
} from '../../src/adapters/local/index.ts'
import { LocalNotebookStore } from '../../src/adapters/local/fs-store.ts'
import { personalNotebook, workspaceNotebook } from '../../src/domain/notebook-ref.ts'
import { GitHistory } from '../../src/adapters/local/git-history.ts'
import { FIXTURE, fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, CaptureLogger, NOW, TODAY } from '../helpers/service.ts'
import { tempDir } from '../helpers/tmp.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

async function localFixture() {
  const dir = await tempDir()
  await cp(FIXTURE, dir, { recursive: true })
  const history = new GitHistory(localDirFor(dir))
  await history.init(NB)
  git(dir, 'add', '-A')
  git(
    dir,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-q',
    '-m',
    'Fixture',
  )
  const logger = new CaptureLogger()
  const service = createLocalService({ dir, logger, clock: { now: () => NOW } })
  return { dir, service, logger }
}

describe('init', () => {
  it('starts a notebook with the starter files and one commit', async () => {
    const dir = join(await tempDir(), 'notebook')
    const service = createLocalService({
      dir,
      logger: new CaptureLogger(),
      clock: { now: () => NOW },
    })
    const r = await service.init(NB, { actor: { client: 'cli' }, timezone: 'Europe/Berlin' })
    assert.ok(r.files.includes('actions.md'))
    assert.ok(r.files.includes('log/2026-10-17.md'))
    assert.match(
      await readFile(join(dir, 'my-rules.md'), 'utf8'),
      /^---\ntimezone: Europe\/Berlin\nnudges_per_day: 3\nstale_days: 30\nmeeting_prep: offer\n---\n# My rules\n/,
    )
    assert.equal(git(dir, 'log', '--format=%an|%s').trim(), 'cli|Started the notebook')
    assert.match(
      await readFile(join(dir, 'log', '2026-10-17.md'), 'utf8'),
      /- 16:05 Started the notebook \[by:: cli\] \[change:: ch_/,
    )
    assert.equal((await refusal(service.init(NB, { actor: { client: 'cli' } }))).code, 'conflict')
  })
})

describe('local service with git', () => {
  it('commits each change with the actor as author and the change id as a trailer', async () => {
    const { dir, service } = await localFixture()
    const r = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'action', text: 'Book the venue for March' }] },
      AGENT,
    )
    const [author, email, subject] = git(dir, 'log', '-1', '--format=%an|%ae|%s').trim().split('|')
    assert.equal(author, 'claude-desktop for Alex')
    assert.equal(email, 'claude-desktop@clients.cos-notebook.invalid')
    assert.equal(subject, 'Added "Book the venue for March" to actions.md')
    assert.equal(
      git(dir, 'log', '-1', '--format=%(trailers:key=Cos-Change,valueonly)').trim(),
      r.change_id,
    )
    assert.equal(git(dir, 'log', '-1', '--format=%cn').trim(), 'cos-notebook')
    assert.deepEqual(
      git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(),
      ['actions.md', `log/${TODAY}.md`],
    )
    assert.equal(git(dir, 'status', '--porcelain'), '')
  })

  it('keeps CRLF files and files with no final newline byte for byte', async () => {
    const { dir, service } = await localFixture()
    await service.applyChanges(
      NB,
      {
        operations: [
          { op: 'update', match: 'Notion', file: 'sources.md', fields: { status: 'connected' } },
          { op: 'add', kind: 'fact', text: 'The offsite is in Lisbon' },
        ],
      },
      AGENT,
    )
    const sources = await readFile(join(dir, 'sources.md'), 'utf8')
    assert.equal(
      sources,
      fixtureNotes().get('sources.md')!.replace('[status:: not connected]', '[status:: connected]'),
    )
    const facts = await readFile(join(dir, 'facts.md'), 'utf8')
    assert.ok(
      facts.endsWith(
        `[src:: onboarding 2026-10-01]\n- The offsite is in Lisbon [src:: cv ${TODAY}]`,
      ),
    )
  })

  it('undoes a change even after a later change to another part of the same file', async () => {
    const { dir, service } = await localFixture()
    const first = await service.applyChanges(
      NB,
      { operations: [{ op: 'complete', match: 'Reply to Jordan' }] },
      AGENT,
    )
    await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'action', text: 'Order new badges' }] },
      AGENT,
    )
    const u = await service.undo(NB, first.change_id!, AGENT)
    const actions = await readFile(join(dir, 'actions.md'), 'utf8')
    assert.ok(
      actions.includes(
        '- [ ] Reply to [[Jordan Kim]] with Q3 churn numbers [due:: 2026-10-14] [src:: gmail 2026-10-12]\n',
      ),
    )
    assert.ok(actions.includes('Order new badges'))
    assert.equal(
      git(dir, 'log', '-1', '--format=%(trailers:key=Cos-Change,valueonly)').trim(),
      u.change_id,
    )
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '4')
  })

  it('refuses an undo whose lines were changed since', async () => {
    const { service } = await localFixture()
    const first = await service.applyChanges(
      NB,
      { operations: [{ op: 'complete', match: 'Reply to Jordan' }] },
      AGENT,
    )
    await service.applyChanges(
      NB,
      { operations: [{ op: 'update', match: 'Reply to Jordan', fields: { due: '2026-10-30' } }] },
      AGENT,
    )
    const e = await refusal(service.undo(NB, first.change_id!, AGENT))
    assert.equal(e.code, 'conflict')
    assert.match(e.message, /actions\.md/)
  })

  it('answers a stale id with what the item became, from git history', async () => {
    const { service } = await localFixture()
    const [item] = await service.listItems(NB, { file: 'waiting.md' })
    await service.applyChanges(
      NB,
      { operations: [{ op: 'update', id: item!.id, fields: { nudged: TODAY } }] },
      AGENT,
    )
    const e = await refusal(
      service.applyChanges(NB, { operations: [{ op: 'complete', id: item!.id }] }, AGENT),
    )
    assert.equal(e.code, 'stale_id')
    assert.equal((e.details.now as { text: string }).text, item!.text)
  })

  it('remembers idempotency keys across service instances', async () => {
    const { dir, service } = await localFixture()
    const req = {
      operations: [{ op: 'add', kind: 'inbox', text: 'Retry me' }],
      idempotency_key: 'k-12345678',
    }
    const first = await service.applyChanges(NB, req, AGENT)
    const again = createLocalService({
      dir,
      logger: new CaptureLogger(),
      clock: { now: () => NOW },
    })
    const second = await again.applyChanges(NB, req, AGENT)
    assert.equal(second.replayed, true)
    assert.equal(second.change_id, first.change_id)
    assert.equal(git(dir, 'status', '--porcelain'), '')
  })

  it('reads notes with ids and problems', async () => {
    const { service } = await localFixture()
    const note = await service.readNote(NB, 'inbox.md')
    assert.equal(note.items.length, 5)
    assert.deepEqual(
      note.problems.map((p) => p.line),
      [8, 8, 9],
    )
    assert.equal(note.items[0]!.done, null)
    assert.deepEqual(note.items[0]!.quote, [
      'Something about Stripe changing invoices. Might matter for pricing, not sure.',
    ])
    assert.deepEqual(note.items[1]!.quote, [])
  })

  it('keeps note text out of the logs', async () => {
    const { service, logger } = await localFixture()
    await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'fact', text: 'Quokka-canary-4410 likes tea' }] },
      AGENT,
    )
    await refusal(
      service.applyChanges(
        NB,
        { operations: [{ op: 'complete', match: 'Quokka-canary-4410' }] },
        AGENT,
      ),
    )
    for (const line of logger.lines) assert.ok(!line.includes('Quokka'), line)
  })
})

describe('local store', () => {
  it('lists notes without hidden folders or symbolic links, and refuses paths outside', async () => {
    const dir = await tempDir()
    const store = new LocalNotebookStore(localDirFor(dir))
    await store.write(NB, [{ path: 'people/Dana Whitfield.md', content: '# Dana Whitfield\n' }])
    await writeFile(join(dir, 'notes.txt'), 'x')
    await symlink('/etc', join(dir, 'etc-link'))
    await writeFile(join(dir, 'outside.md'), 'x')
    await symlink(join(dir, 'outside.md'), join(dir, 'linked.md'))
    assert.deepEqual(await store.list(NB), ['outside.md', 'people/Dana Whitfield.md'])
    await assert.rejects(store.read(NB, '../secret.md'))
    await assert.rejects(store.write(NB, [{ path: '.git/config.md', content: 'x' }]))
  })
})

describe('segmented local layout', () => {
  it('keeps personal and workspace notebooks in separate folders, each with its own history', async () => {
    const root = await tempDir()
    const service = createLocalService({
      root,
      logger: new CaptureLogger(),
      clock: { now: () => NOW },
    })
    const personal = personalNotebook('alex')
    const work = workspaceNotebook('northwind', 'alex')
    await service.init(personal, { actor: AGENT, timezone: 'UTC' })
    await service.init(work, { actor: AGENT, timezone: 'UTC' })
    await service.applyChanges(
      work,
      { operations: [{ op: 'add', kind: 'action', text: 'Ship SSO' }] },
      AGENT,
    )
    const personalDir = join(root, 'personal', 'alex', 'default')
    const workDir = join(root, 'workspaces', 'northwind', 'alex')
    assert.match(await readFile(join(workDir, 'actions.md'), 'utf8'), /Ship SSO/)
    assert.doesNotMatch(await readFile(join(personalDir, 'actions.md'), 'utf8'), /Ship SSO/)
    assert.equal(git(workDir, 'rev-list', '--count', 'HEAD').trim(), '2')
    assert.equal(git(personalDir, 'rev-list', '--count', 'HEAD').trim(), '1')
    // Deleting the workspace's tree leaves the person's own notebook untouched.
    await rm(join(root, 'workspaces'), { recursive: true })
    const notes = await service.listItems(personal)
    assert.ok(Array.isArray(notes))
    assert.equal((await refusal(service.listItems(work))).code, 'not_a_notebook')
  })

  it('a one-folder service holds only the local notebook', async () => {
    const dir = await tempDir()
    const service = createLocalService({ dir, logger: new CaptureLogger() })
    await assert.rejects(
      service.init(workspaceNotebook('northwind', 'alex'), { actor: AGENT }),
      /one notebook/,
    )
  })
})

describe('edits made outside the service', () => {
  it('are recorded as their own change before the next write', async () => {
    const { dir, service } = await localFixture()
    const actionsPath = join(dir, 'actions.md')
    const handEdited = (await readFile(actionsPath, 'utf8')).replace(
      '- [ ] Reply to [[Jordan Kim]]',
      '- [ ] Call [[Jordan Kim]]',
    )
    await writeFile(actionsPath, handEdited)
    await writeFile(join(dir, 'people', 'Sam Okafor.md'), '# Sam Okafor\n')
    await rm(join(dir, 'areas', 'Hiring.md'))

    const r = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'action', text: 'Book the venue' }] },
      AGENT,
    )
    const outside = r.warnings.find((w) => w.code === 'outside_edits')!
    assert.deepEqual(outside.files, ['actions.md', 'areas/Hiring.md', 'people/Sam Okafor.md'])

    const [agentCommit, outsideCommit] = git(dir, 'log', '-2', '--format=%an|%s').trim().split('\n')
    assert.equal(
      outsideCommit,
      'outside the service|Edited outside the service: actions.md, areas/Hiring.md, people/Sam Okafor.md',
    )
    assert.match(agentCommit!, /^claude-desktop for Alex\|Added "Book the venue"/)
    // The hand edit is in the outside commit, not the agent's.
    assert.match(
      git(dir, 'show', 'HEAD~1', '--', 'actions.md'),
      /\+- \[ \] Call \[\[Jordan Kim\]\]/,
    )
    assert.doesNotMatch(git(dir, 'show', 'HEAD', '--', 'actions.md'), /Jordan Kim/)
    assert.equal(git(dir, 'status', '--porcelain'), '')
    const log = await readFile(join(dir, 'log', `${TODAY}.md`), 'utf8')
    assert.match(
      log,
      new RegExp(
        `- 10:05 Edited outside the service: actions\\.md, areas/Hiring\\.md, people/Sam Okafor\\.md \\[by:: outside the service\\] \\[change:: ${outside.change_id}\\]\\n- 10:05 Added "Book the venue"`,
      ),
    )
  })

  it('keep hand-written lines that do not fit the format, as they are', async () => {
    const { dir, service } = await localFixture()
    await writeFile(join(dir, 'inbox.md'), '# Inbox\n\n- [due: soon] half typed [[link\n')
    await service.applyChanges(NB, { operations: [{ op: 'log', text: 'Checked in' }] }, AGENT)
    assert.equal(
      git(dir, 'show', 'HEAD~1:inbox.md'),
      '# Inbox\n\n- [due: soon] half typed [[link\n',
    )
  })

  it('add nothing when nothing changed, and ignore hidden and non-note files', async () => {
    const { dir, service } = await localFixture()
    await writeFile(join(dir, 'notes.txt'), 'scratch')
    await writeFile(join(dir, 'drafts', '.history', 'Board narrative', 'v2.md'), 'old')
    const r = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'idea', text: 'A podcast' }] },
      AGENT,
    )
    assert.ok(!r.warnings.some((w) => w.code === 'outside_edits'))
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '2')
  })

  it('are left alone by a dry run, and recorded before an undo', async () => {
    const { dir, service } = await localFixture()
    const first = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'idea', text: 'A podcast' }] },
      AGENT,
    )
    await writeFile(join(dir, 'facts.md'), 'Edited by hand\n')
    const dry = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'idea', text: 'A newsletter' }], dry_run: true },
      AGENT,
    )
    assert.ok(!dry.warnings.some((w) => w.code === 'outside_edits'))
    assert.match(git(dir, 'status', '--porcelain'), /facts\.md/)
    await service.undo(NB, first.change_id!, AGENT)
    assert.deepEqual(git(dir, 'log', '-2', '--format=%an').trim().split('\n'), [
      'claude-desktop for Alex',
      'outside the service',
    ])
    assert.equal(await readFile(join(dir, 'facts.md'), 'utf8'), 'Edited by hand\n')
  })
})

describe('write tools on disk', () => {
  it('commit a draft version together with its kept earlier version', async () => {
    const { dir, service } = await localFixture()
    await service.saveDraft(
      NB,
      { name: 'Board narrative', draft: 'Shorter.', change: 'shorter' },
      AGENT,
    )
    assert.deepEqual(
      git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(),
      ['drafts/.history/Board narrative/v2.md', 'drafts/Board narrative.md', `log/${TODAY}.md`],
    )
    assert.equal(git(dir, 'status', '--porcelain'), '')
    assert.equal(
      await readFile(join(dir, 'drafts', '.history', 'Board narrative', 'v2.md'), 'utf8'),
      fixtureNotes().get('drafts/Board narrative.md'),
    )
  })
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createLocalService, LOCAL_NOTEBOOK as NB } from '../../src/adapters/local/index.ts'
import { workspaceNotebook } from '../../src/domain/notebook-ref.ts'
import { FIXTURE, fixtureNotes } from '../helpers/fixture.ts'
import { refusal } from '../helpers/refusal.ts'
import { AGENT, CaptureLogger, NOW, TODAY } from '../helpers/service.ts'
import { tempDir } from '../helpers/tmp.ts'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const CLI = { client: 'cli' }

function serviceFor(dir: string) {
  return createLocalService({ dir, logger: new CaptureLogger(), clock: { now: () => NOW } })
}

describe('adopt', () => {
  it('makes a notebook of a plain folder without rewriting a single note', async () => {
    const dir = await tempDir()
    await cp(FIXTURE, dir, { recursive: true })
    // Files a plugin folder also has, which aren't notes.
    await writeFile(join(dir, 'setup.conf'), 'OWNER_NAME=Alex\n')
    await mkdir(join(dir, 'log', 'transcripts'))
    await writeFile(join(dir, 'log', 'transcripts', 'session.jsonl'), '{}\n')

    const r = await serviceFor(dir).adopt(NB, { actor: CLI })
    const notes = fixtureNotes()
    assert.equal(r.notes, notes.size)
    assert.deepEqual(r.added, [])
    assert.equal(r.timezone, 'America/New_York')
    assert.equal(r.problem_count, 4)
    assert.deepEqual(r.other_notes, [])

    // Every note is byte for byte what it was, and history starts with exactly those bytes.
    for (const [path, text] of notes) {
      assert.equal(await readFile(join(dir, path), 'utf8'), text, path)
      assert.equal(git(dir, 'show', `HEAD~1:${path}`), text, path)
    }
    assert.deepEqual(git(dir, 'log', '--format=%an|%s').trim().split('\n'), [
      `cli|Adopted the notebook (${notes.size} notes)`,
      `outside the service|Notes as they were when the notebook was adopted (${notes.size})`,
    ])
    assert.match(
      await readFile(join(dir, 'log', `${TODAY}.md`), 'utf8'),
      new RegExp(
        `- 10:05 Adopted the notebook \\(${notes.size} notes\\) \\[by:: cli\\] \\[change:: ${r.change_id}\\]\\n$`,
      ),
    )
    assert.ok(!git(dir, 'ls-files').includes('transcripts'))
    assert.ok(!git(dir, 'ls-files').includes('setup.conf'))

    // It works as a notebook from here on, including undo.
    const service = serviceFor(dir)
    const w = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'inbox', text: 'First note after adopting' }] },
      AGENT,
    )
    await service.undo(NB, w.change_id!, AGENT)
    assert.equal(await readFile(join(dir, 'inbox.md'), 'utf8'), notes.get('inbox.md'))
  })

  it('adds missing starter files and the time zone, touching nothing else', async () => {
    const dir = await tempDir()
    const actions = '# My actions\n\n## To do\n- [ ] Call the bank [src:: cv 2026-10-01]\n'
    const rules = '---\nstale_days: 14\n---\n# My rules for Ada\n'
    await writeFile(join(dir, 'actions.md'), actions)
    await writeFile(join(dir, 'my-rules.md'), rules)
    await writeFile(join(dir, 'Reading list.md'), '- Some book\n')

    const r = await serviceFor(dir).adopt(NB, { actor: CLI, timezone: 'Europe/Berlin' })
    assert.equal(r.notes, 3)
    assert.ok(r.added.includes('now.md') && r.added.includes('about-me.md'))
    assert.ok(!r.added.includes('actions.md') && !r.added.includes('my-rules.md'))
    assert.deepEqual(r.other_notes, ['Reading list.md'])
    assert.equal(await readFile(join(dir, 'actions.md'), 'utf8'), actions)
    assert.equal(
      await readFile(join(dir, 'my-rules.md'), 'utf8'),
      '---\nstale_days: 14\ntimezone: Europe/Berlin\n---\n# My rules for Ada\n',
    )
    assert.match(await readFile(join(dir, 'now.md'), 'utf8'), /^# Now\n/)
    assert.equal(git(dir, 'show', 'HEAD~1:my-rules.md'), rules)
  })

  it('gives a folder inside another repository its own history', async () => {
    const outer = await tempDir()
    git(outer, 'init', '-q')
    const dir = join(outer, 'cos')
    await mkdir(dir)
    await writeFile(join(dir, 'inbox.md'), '# Inbox\n\n- Something [src:: cv 2026-10-01]\n')
    const r = await serviceFor(dir).adopt(NB, { actor: CLI, timezone: 'UTC' })
    assert.ok(existsSync(join(dir, '.git')))
    assert.equal(git(dir, 'rev-parse', '--show-toplevel').trim(), dir)
    assert.equal(r.warnings[0]!.code, 'inside_another_repository')
    assert.throws(() => git(outer, 'rev-parse', '--verify', '-q', 'HEAD'))
  })

  it('keeps history a folder already has, on any branch name', async () => {
    const dir = await tempDir()
    git(dir, 'init', '-q', '-b', 'master')
    await writeFile(join(dir, 'ideas.md'), '# Come back to\n\n- A podcast [src:: cv 2026-09-01]\n')
    git(dir, 'add', '-A')
    git(
      dir,
      '-c',
      'user.name=Alex',
      '-c',
      'user.email=alex@example.com',
      'commit',
      '-q',
      '-m',
      'My notes',
    )
    await writeFile(
      join(dir, 'ideas.md'),
      '# Come back to\n\n- A podcast [src:: cv 2026-09-01]\n- A newsletter\n',
    )

    const service = serviceFor(dir)
    const r = await service.adopt(NB, { actor: CLI, timezone: 'UTC' })
    assert.equal(r.warnings[0]!.code, 'existing_history')
    assert.deepEqual(git(dir, 'log', '--format=%s').trim().split('\n').slice(1), [
      'Notes as they were when the notebook was adopted (1)',
      'My notes',
    ])
    assert.equal(git(dir, 'branch', '--show-current').trim(), 'master')
    const w = await service.applyChanges(
      NB,
      { operations: [{ op: 'add', kind: 'idea', text: 'A book club' }] },
      AGENT,
    )
    await service.undo(NB, w.change_id!, AGENT)
  })

  it('refuses an empty folder and a folder that is already a notebook', async () => {
    const empty = await tempDir()
    assert.equal((await refusal(serviceFor(empty).adopt(NB, { actor: CLI }))).code, 'not_found')
    const started = join(await tempDir(), 'nb')
    await serviceFor(started).init(NB, { actor: CLI, timezone: 'UTC' })
    assert.equal((await refusal(serviceFor(started).adopt(NB, { actor: CLI }))).code, 'conflict')
    const adopted = await tempDir()
    await writeFile(join(adopted, 'inbox.md'), '# Inbox\n')
    await serviceFor(adopted).adopt(NB, { actor: CLI, timezone: 'UTC' })
    const again = await refusal(serviceFor(adopted).adopt(NB, { actor: CLI }))
    assert.equal(again.code, 'conflict')
    assert.equal((await refusal(serviceFor(adopted).init(NB, { actor: CLI }))).code, 'conflict')
  })
})

describe('adopting a work notebook', () => {
  it('adds the workspace starter files, never about-me.md', async () => {
    const root = await tempDir()
    const service = createLocalService({
      root,
      logger: new CaptureLogger(),
      clock: { now: () => NOW },
    })
    const work = workspaceNotebook('northwind', 'alex')
    const dir = join(root, 'workspaces', 'northwind', 'alex')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'actions.md'), '# My actions\n\n## To do\n')
    const r = await service.adopt(work, { actor: CLI, timezone: 'UTC' })
    assert.ok(!r.added.includes('about-me.md'))
    assert.ok(!existsSync(join(dir, 'about-me.md')))
    assert.match(
      await readFile(join(dir, 'my-rules.md'), 'utf8'),
      /^---\ntimezone: UTC\n---\n# My rules for this workspace/,
    )
  })
})

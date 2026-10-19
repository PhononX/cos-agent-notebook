// History as one git repository per notebook, using the system git binary. Each change is one
// commit whose message ends with a `Cos-Change: <id>` trailer, so change ids survive history
// being rewritten by retention.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Author,
  ChangeRecord,
  ChangeSummary,
  History,
  HistoryState,
  NotebookRef,
} from '../../domain/ports.ts'
import type { DirFor } from './fs-store.ts'
import { STATE_DIR } from './file-idempotency.ts'

const SERVICE: Author = { name: 'cos-notebook', email: 'service@cos-notebook.invalid' }
const TRAILER = 'Cos-Change'

// Settings that make git behave the same whatever the person's own git configuration says:
// no hooks, no signing prompts, bytes kept exactly, file names unquoted.
const GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'init.defaultBranch=main',
]

interface GitResult {
  stdout: Buffer
  code: number
}

function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; input?: string; allowFail?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      [...GIT_CONFIG, ...args],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          LC_ALL: 'C',
          ...opts.env,
        },
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        // Errors name the git subcommand and exit code only; git's own output can quote note text.
        if (err && !opts.allowFail)
          reject(new Error(`git ${args[0]} failed with exit code ${code}`))
        else resolvePromise({ stdout, code })
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export class GitHistory implements History {
  private readonly dirFor: DirFor

  constructor(dirFor: DirFor) {
    this.dirFor = dirFor
  }

  /** Starts a repository in the notebook's own folder, or reuses one already there. */
  async init(notebook: NotebookRef): Promise<void> {
    const dir = this.dirFor(notebook)
    const own = (await this.state(notebook)).existingHistory || existsSync(join(dir, '.git'))
    if (!own) await git(['init', '-q', '-b', 'main'], { cwd: dir })
    // The service's own state never goes into history.
    const exclude = join(dir, '.git', 'info', 'exclude')
    await mkdir(join(dir, '.git', 'info'), { recursive: true })
    const current = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
    if (!current.split('\n').includes(`${STATE_DIR}/`)) {
      await writeFile(
        exclude,
        `${current}${current && !current.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`,
      )
    }
  }

  async state(notebook: NotebookRef): Promise<HistoryState> {
    const dir = this.dirFor(notebook)
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true })
    if (top.code !== 0)
      return { notebook: false, existingHistory: false, insideAnotherRepository: false }
    const own = (await realpath(top.stdout.toString('utf8').trim())) === (await realpath(dir))
    if (!own) return { notebook: false, existingHistory: false, insideAnotherRepository: true }
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir, allowFail: true })
    if (head.code !== 0)
      return { notebook: false, existingHistory: false, insideAnotherRepository: false }
    const ours = await git(['log', '-1', '--format=%H', `--grep=^${TRAILER}: `, 'HEAD'], {
      cwd: dir,
    })
    return {
      notebook: ours.stdout.toString('utf8').trim() !== '',
      existingHistory: true,
      insideAnotherRepository: false,
    }
  }

  async commit(
    notebook: NotebookRef,
    change: { changeId: string; summary: string; author: Author; paths: readonly string[] },
  ): Promise<void> {
    const cwd = this.dirFor(notebook)
    const subject = change.summary.replace(/\s+/g, ' ').slice(0, 200)
    await git(['add', '-A', '--', ...change.paths], { cwd })
    await git(
      [
        'commit',
        '-q',
        '--no-verify',
        '-m',
        subject,
        '-m',
        `${TRAILER}: ${change.changeId}`,
        '--',
        ...change.paths,
      ],
      {
        cwd,
        env: {
          GIT_AUTHOR_NAME: change.author.name,
          GIT_AUTHOR_EMAIL: change.author.email,
          GIT_COMMITTER_NAME: SERVICE.name,
          GIT_COMMITTER_EMAIL: SERVICE.email,
        },
      },
    )
  }

  async findChange(notebook: NotebookRef, changeId: string): Promise<ChangeRecord | null> {
    const cwd = this.dirFor(notebook)
    if (!/^ch_[0-9a-z]{8}$/.test(changeId)) return null
    const found = await git(
      ['log', '-1', '--format=%H', `--grep=^${TRAILER}: ${changeId}$`, 'HEAD'],
      {
        cwd,
        allowFail: true,
      },
    )
    const sha = found.stdout.toString('utf8').trim()
    if (found.code !== 0 || !sha) return null
    const meta = (
      await git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%s', sha], { cwd })
    ).stdout
      .toString('utf8')
      .replace(/\n$/, '')
      .split('\0')
    const names = (
      await git(['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--name-only', sha], { cwd })
    ).stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    const blobs = await readBlobs(
      cwd,
      names.flatMap((p) => [`${sha}^:${p}`, `${sha}:${p}`]),
    )
    return {
      changeId,
      summary: meta[3] ?? '',
      author: { name: meta[0] ?? '', email: meta[1] ?? '' },
      time: meta[2] ?? '',
      files: names.map((path, i) => ({
        path,
        before: blobs[2 * i] ?? null,
        after: blobs[2 * i + 1] ?? null,
      })),
    }
  }

  async outsideChanges(notebook: NotebookRef): Promise<string[]> {
    const cwd = this.dirFor(notebook)
    const { stdout } = await git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
      { cwd },
    )
    // Each entry is "XY <path>"; anything git lists differs from the last commit.
    return stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
      .filter((path) => path.endsWith('.md') && !path.split('/').some((p) => p.startsWith('.')))
      .sort()
  }

  async listChanges(
    notebook: NotebookRef,
    opts: { limit: number; offset?: number },
  ): Promise<ChangeSummary[]> {
    const cwd = this.dirFor(notebook)
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, allowFail: true })
    if (head.code !== 0) return []
    // One record per commit: a marker line, then the fields, then the paths it touched.
    const out = await git(
      [
        'log',
        `-n${opts.limit}`,
        `--skip=${opts.offset ?? 0}`,
        `--format=%x1e%an%x1f%ae%x1f%aI%x1f%s%x1f%(trailers:key=${TRAILER},valueonly,separator=)`,
        '--name-only',
        'HEAD',
      ],
      { cwd },
    )
    return out.stdout
      .toString('utf8')
      .split('\x1e')
      .slice(1)
      .map((record) => {
        const [meta = '', ...rest] = record.split('\n')
        const [name = '', email = '', time = '', summary = '', changeId = ''] = meta.split('\x1f')
        return {
          changeId: changeId.trim() || null,
          summary,
          author: { name, email },
          time,
          paths: rest.map((l) => l.trim()).filter(Boolean),
        }
      })
  }

  async recentVersions(
    notebook: NotebookRef,
    changes: number,
  ): Promise<{ path: string; content: string }[]> {
    const cwd = this.dirFor(notebook)
    const out = await git(['log', `-n${changes}`, '--format=%H', '--name-only', 'HEAD'], {
      cwd,
      allowFail: true,
    })
    if (out.code !== 0) return []
    const specs: { path: string; spec: string }[] = []
    let sha = ''
    for (const line of out.stdout.toString('utf8').split('\n')) {
      if (/^[0-9a-f]{40}$/.test(line)) sha = line
      else if (line.endsWith('.md') && sha) specs.push({ path: line, spec: `${sha}^:${line}` })
    }
    const blobs = await readBlobs(
      cwd,
      specs.map((s) => s.spec),
    )
    return specs.flatMap((s, i) => (blobs[i] == null ? [] : [{ path: s.path, content: blobs[i] }]))
  }

  async merge(
    base: string,
    ours: string,
    theirs: string,
  ): Promise<{ text: string; conflict: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), 'cos-notebook-merge-'))
    try {
      const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => join(dir, n))
      await writeFile(b!, base, { mode: 0o600 })
      await writeFile(o!, ours, { mode: 0o600 })
      await writeFile(t!, theirs, { mode: 0o600 })
      const r = await git(['merge-file', '-q', o!, b!, t!], { allowFail: true })
      if (r.code < 0 || r.code > 127) throw new Error('git merge-file failed')
      return { text: await readFile(o!, 'utf8'), conflict: r.code !== 0 }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** Reads many `<rev>:<path>` blobs with one `git cat-file --batch`; missing ones are null. */
async function readBlobs(cwd: string, specs: readonly string[]): Promise<(string | null)[]> {
  if (!specs.length) return []
  const { stdout } = await git(['cat-file', '--batch'], {
    cwd,
    input: specs.map((s) => `${s}\n`).join(''),
  })
  const out: (string | null)[] = []
  let pos = 0
  for (let i = 0; i < specs.length; i++) {
    const nl = stdout.indexOf(10, pos)
    const header = stdout.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header)
    if (!m) {
      out.push(null)
      continue
    }
    const size = Number(m[2])
    out.push(m[1] === 'blob' ? stdout.subarray(pos, pos + size).toString('utf8') : null)
    pos += size + 1
  }
  return out
}

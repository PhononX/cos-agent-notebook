// History as one git repository per notebook, using the system git binary. Each change is one
// commit whose message ends with a `Cos-Change: <id>` trailer, so change ids survive history
// being rewritten by retention.

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Author, ChangeRecord, History, NotebookRef } from '../../domain/ports.ts'
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

  async init(notebook: NotebookRef): Promise<void> {
    const dir = this.dirFor(notebook)
    await git(['init', '-q', '-b', 'main'], { cwd: dir })
    // The service's own state never goes into history.
    await mkdir(join(dir, '.git', 'info'), { recursive: true })
    await writeFile(join(dir, '.git', 'info', 'exclude'), `${STATE_DIR}/\n`)
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
      ['log', '-1', '--format=%H', `--grep=^${TRAILER}: ${changeId}$`, 'main'],
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

  async recentVersions(
    notebook: NotebookRef,
    changes: number,
  ): Promise<{ path: string; content: string }[]> {
    const cwd = this.dirFor(notebook)
    const out = await git(['log', `-n${changes}`, '--format=%H', '--name-only', 'main'], {
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

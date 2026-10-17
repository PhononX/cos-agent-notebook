#!/usr/bin/env node
// The cos-notebook command.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createLocalService, JsonLogger, LOCAL_NOTEBOOK } from '../adapters/local/index.ts'
import { loadConfig } from '../config.ts'
import { NotebookError } from '../domain/errors.ts'

const HELP = `cos-notebook: the Chief of Staff notebook service

Usage:
  cos-notebook init [folder] [--timezone <zone>]   Start a notebook (default folder: $COS_NOTEBOOK_DIR or ~/cos-notebook)
  cos-notebook --version                          Print the version
  cos-notebook --help                             Show this help

Coming in later milestones: serve, mcp, sync, token, retention, export.
Settings are environment variables; see docs/configuration.md.
`

const LATER: Record<string, string> = {
  serve: 'the local service (milestone 2)',
  mcp: 'MCP over stdio (milestone 2)',
  token: 'notebook tokens (milestone 6)',
  sync: 'the sync engine (milestone 5)',
  retention: 'history retention (milestone 5)',
  export: 'export (milestone 5)',
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  return pkg.version
}

async function init(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { timezone: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (values.help) {
    console.log('Usage: cos-notebook init [folder] [--timezone <zone>]')
    return 0
  }
  if (positionals.length > 1) throw new UsageError('init takes at most one folder.')
  const config = loadConfig()
  const dir = positionals[0] ? resolve(positionals[0]) : config.dir
  const service = createLocalService({
    dir,
    defaultTimezone: config.timezone,
    logger: new JsonLogger({ quiet: true }),
  })
  const r = await service.init(LOCAL_NOTEBOOK, {
    actor: { client: 'cli' },
    ...(values.timezone ? { timezone: values.timezone } : {}),
  })
  console.log(`Started a notebook in ${dir} (${r.files.length} files, change ${r.change_id}).`)
  return 0
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return 0
  }
  if (command === '--version' || command === '-v') {
    console.log(version())
    return 0
  }
  if (command === 'init') return init(rest)
  if (LATER[command]) {
    console.error(`cos-notebook ${command} isn't available yet: it comes with ${LATER[command]}.`)
    return 2
  }
  throw new UsageError(`Unknown command "${command}". Run cos-notebook --help.`)
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    if (e instanceof NotebookError || e instanceof UsageError) {
      console.error(e.message)
      process.exitCode = e instanceof UsageError ? 2 : 1
    } else if (
      e instanceof Error &&
      /parseArgs|ERR_PARSE_ARGS/.test(String((e as { code?: string }).code ?? ''))
    ) {
      console.error(`${e.message}. Run cos-notebook --help.`)
      process.exitCode = 2
    } else {
      console.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
    }
  },
)

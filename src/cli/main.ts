#!/usr/bin/env node
// The cos-notebook command.

import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureTokenFile, StaticTokenAuth, type Principal } from '../adapters/http/auth.ts'
import { createHttpServer, LOCAL_HOSTS } from '../adapters/http/server.ts'
import { createLocalService, JsonLogger, LOCAL_NOTEBOOK } from '../adapters/local/index.ts'
import { mcpHttpHandler, serveStdio } from '../adapters/mcp/transports.ts'
import { loadConfig, type Config } from '../config.ts'
import { NotebookError } from '../domain/errors.ts'
import type { NotebookService } from '../domain/service.ts'

const HELP = `cos-notebook: the Chief of Staff notebook service

Usage:
  cos-notebook init [folder] [--timezone <zone>]   Start a notebook (default folder: $COS_NOTEBOOK_DIR or ~/cos-notebook)
  cos-notebook adopt [folder] [--timezone <zone>]  Make a notebook of a folder that already has notes, as they are
  cos-notebook serve [folder] [--port <n>] [--host <address>]
                                                  Serve the HTTP API at /v1 and MCP at /mcp (default 127.0.0.1:4317)
  cos-notebook mcp [folder]                       Serve MCP over stdio, for an agent that starts the server itself
  cos-notebook --version                          Print the version
  cos-notebook --help                             Show this help

Coming in later milestones: sync, token, retention, export.
Settings are environment variables; see docs/configuration.md.
`

const LATER: Record<string, string> = {
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

async function adopt(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { timezone: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(
      "Usage: cos-notebook adopt [folder] [--timezone <zone>]\n\nMakes a notebook of a folder that already has notes (such as a Chief of Staff plugin cos/ folder), where it is. Nothing is rewritten: history starts with the notes as they are, then missing starter files and the time zone are added. --timezone is used only if my-rules.md doesn't set one.",
    )
    return 0
  }
  if (positionals.length > 1) throw new UsageError('adopt takes at most one folder.')
  const config = loadConfig()
  const dir = positionals[0] ? resolve(positionals[0]) : config.dir
  const service = createLocalService({
    dir,
    defaultTimezone: config.timezone,
    logger: new JsonLogger({ quiet: true }),
  })
  const r = await service.adopt(LOCAL_NOTEBOOK, {
    actor: { client: 'cli' },
    ...(values.timezone ? { timezone: values.timezone } : {}),
  })
  console.log(`Adopted ${dir}: ${r.notes} notes, time zone ${r.timezone} (change ${r.change_id}).`)
  if (r.added.length) console.log(`Added missing files: ${r.added.join(', ')}.`)
  if (r.other_notes.length) {
    console.log(`Kept ${r.other_notes.length} notes the format doesn't define, as free notes.`)
  }
  if (r.problem_count) {
    console.log(`${r.problem_count} lines don't fit the format; they were left as they are:`)
    for (const p of r.problems.slice(0, 10)) console.log(`  ${p.path}:${p.line} ${p.message}`)
    if (r.problem_count > 10) console.log(`  …and ${r.problem_count - 10} more.`)
  }
  for (const w of r.warnings) console.log(w.message)
  return 0
}

/** The local service for one folder, refusing a folder that holds no notebook yet. */
async function openNotebook(dir: string, config: Config): Promise<NotebookService> {
  const service = createLocalService({
    dir,
    defaultTimezone: config.timezone,
    logger: new JsonLogger({ quiet: config.logLevel === 'warn' }),
  })
  if (!(await service.listNotes(LOCAL_NOTEBOOK)).length) {
    throw new NotebookError(
      'not_a_notebook',
      `${dir} has no notebook yet. Start one with cos-notebook init ${dir}, or make one of existing notes with cos-notebook adopt ${dir}.`,
    )
  }
  return service
}

function localPrincipal(config: Config): Principal {
  return {
    access: { notebooks: [LOCAL_NOTEBOOK] },
    ...(config.person ? { person: config.person } : {}),
  }
}

const SERVE_HELP = `Usage: cos-notebook serve [folder] [--port <n>] [--host <address>]

Serves the notebook in [folder] (default: $COS_NOTEBOOK_DIR or ~/cos-notebook):
the HTTP API under /v1 and MCP over Streamable HTTP at /mcp. Every request needs
the local token, kept in .cos-notebook/token in the notebook folder (created the
first time, readable only by you): send it as "Authorization: Bearer <token>".
Listens on 127.0.0.1:4317 unless --host, --port or the environment say otherwise;
requests must name an allowed host (see docs/configuration.md).`

async function serve(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(SERVE_HELP)
    return 0
  }
  if (positionals.length > 1) throw new UsageError('serve takes at most one folder.')
  const config = loadConfig({
    ...process.env,
    ...(values.port !== undefined ? { COS_NOTEBOOK_PORT: values.port } : {}),
    ...(values.host !== undefined ? { COS_NOTEBOOK_HOST: values.host } : {}),
  })
  const dir = positionals[0] ? resolve(positionals[0]) : config.dir
  const service = await openNotebook(dir, config)
  const tokenFile = config.tokenFile ?? join(dir, '.cos-notebook', 'token')
  const token = await ensureTokenFile(tokenFile)
  const logger = new JsonLogger({ quiet: config.logLevel === 'warn' })
  const server = createHttpServer({
    service,
    auth: new StaticTokenAuth(token, localPrincipal(config)),
    logger,
    allowedHosts: [...LOCAL_HOSTS, ...config.allowedHosts],
    mcp: mcpHttpHandler({ service, version: version() }),
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(config.port, config.host, () => ok())
  })
  const { port } = server.address() as AddressInfo
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host
  console.log(`Serving ${dir} at http://${shown}:${port} (HTTP API under /v1, MCP at /mcp).`)
  console.log(`Token: ${tokenFile}`)
  if (!LOCAL_HOSTS.includes(config.host)) {
    console.log(
      `Listening on ${config.host}, not only this computer: anyone who can reach it and has the token can read and change the notebook.`,
    )
  }
  await new Promise<void>((done) => {
    const stop = () => {
      server.close(() => done())
      server.closeAllConnections()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

async function mcp(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(
      'Usage: cos-notebook mcp [folder]\n\nServes MCP over stdio for the notebook in [folder] (default: $COS_NOTEBOOK_DIR or ~/cos-notebook). Add it to an agent as a local MCP server with this command. Logs go to stderr.',
    )
    return 0
  }
  if (positionals.length > 1) throw new UsageError('mcp takes at most one folder.')
  const config = loadConfig()
  const dir = positionals[0] ? resolve(positionals[0]) : config.dir
  const service = await openNotebook(dir, config)
  await serveStdio({ service, principal: localPrincipal(config), version: version() })
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
  if (command === 'adopt') return adopt(rest)
  if (command === 'serve') return serve(rest)
  if (command === 'mcp') return mcp(rest)
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

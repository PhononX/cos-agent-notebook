// Every setting the service reads, in one place. Documented in docs/configuration.md.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isTimeZone } from './format/values.ts'
import { systemTimeZone } from './domain/time.ts'

export interface Config {
  /** The local notebook's folder. */
  dir: string
  /** The time zone for a notebook whose my-rules.md doesn't set one. */
  timezone: string
  /** `info` logs every call; `warn` logs only problems. */
  logLevel: 'info' | 'warn'
  /** The address `serve` listens on. */
  host: string
  port: number
  /** Host names allowed in `Host` and `Origin` besides the loopback ones, like a Tailscale name. */
  allowedHosts: string[]
  /** The local token's file; by default `.cos-notebook/token` in the notebook folder. */
  tokenFile: string | undefined
  /** The person clients act for, recorded in history as `claude-code for <person>`. */
  person: string | undefined
}

const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timezone = env.COS_NOTEBOOK_TIMEZONE || systemTimeZone()
  if (!isTimeZone(timezone)) {
    throw new Error(
      `COS_NOTEBOOK_TIMEZONE is "${timezone}", which isn't a time zone. Use an IANA name like Europe/Berlin.`,
    )
  }
  const logLevel = env.COS_NOTEBOOK_LOG_LEVEL || 'info'
  if (logLevel !== 'info' && logLevel !== 'warn') {
    throw new Error('COS_NOTEBOOK_LOG_LEVEL must be info or warn.')
  }
  const port = Number(env.COS_NOTEBOOK_PORT || 4317)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      'The port (--port or COS_NOTEBOOK_PORT) must be a number from 0 to 65535, like 4317.',
    )
  }
  const allowedHosts = (env.COS_NOTEBOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1'),
    )
    .filter(Boolean)
  for (const h of allowedHosts) {
    if (!HOST_NAME.test(h)) {
      throw new Error(
        `COS_NOTEBOOK_ALLOWED_HOSTS has "${h}", which isn't a host name. List names without scheme or port, separated by commas, like notebook.tail1234.ts.net.`,
      )
    }
  }
  const person = env.COS_NOTEBOOK_PERSON?.trim() || undefined
  if (person !== undefined && /[[\]\r\n]/.test(person)) {
    throw new Error("COS_NOTEBOOK_PERSON must be the person's name on one line, without brackets.")
  }
  return {
    dir: resolve(env.COS_NOTEBOOK_DIR || join(homedir(), 'cos-notebook')),
    timezone,
    logLevel,
    host: env.COS_NOTEBOOK_HOST || '127.0.0.1',
    port,
    allowedHosts,
    tokenFile: env.COS_NOTEBOOK_TOKEN_FILE ? resolve(env.COS_NOTEBOOK_TOKEN_FILE) : undefined,
    person,
  }
}

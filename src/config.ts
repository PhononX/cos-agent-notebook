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
}

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
  return {
    dir: resolve(env.COS_NOTEBOOK_DIR || join(homedir(), 'cos-notebook')),
    timezone,
    logLevel,
  }
}

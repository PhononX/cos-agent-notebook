import type { LogFields, Logger } from '../../domain/ports.ts'

/** JSON lines on stderr. Fields are ids, counts and timings; never note text. */
export class JsonLogger implements Logger {
  private readonly write: (line: string) => void
  private readonly quiet: boolean

  constructor(opts: { write?: (line: string) => void; quiet?: boolean } = {}) {
    this.write = opts.write ?? ((line) => process.stderr.write(`${line}\n`))
    this.quiet = opts.quiet ?? false
  }

  info(event: string, fields?: LogFields) {
    if (!this.quiet) this.log('info', event, fields)
  }
  warn(event: string, fields?: LogFields) {
    this.log('warn', event, fields)
  }
  error(event: string, fields?: LogFields) {
    this.log('error', event, fields)
  }

  private log(level: string, event: string, fields?: LogFields) {
    this.write(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }))
  }
}

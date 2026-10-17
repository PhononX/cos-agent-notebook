import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE = fileURLToPath(new URL('../fixtures/notebook', import.meta.url))

/** Every note in the fixture notebook (hidden folders skipped), by notebook path. */
export function fixtureNotes(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.md')) {
        out.set(relative(FIXTURE, full).split(sep).join('/'), readFileSync(full, 'utf8'))
      }
    }
  }
  walk(FIXTURE)
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

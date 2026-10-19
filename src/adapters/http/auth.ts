// Who is calling. Authentication is pluggable (SPEC.md, Auth): local mode ships a static token
// kept in a file only the owner can read; a hosted deployment provides OAuth instead.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Access } from '../../domain/service.ts'

export interface Principal {
  /** The notebooks this caller may read and write. */
  access: Access
  /** The person the caller acts for, recorded in history. */
  person?: string
  /** Scopes; undefined means every scope (local mode). */
  scopes?: readonly string[]
}

export interface AuthProvider {
  /** The caller for a request's Authorization header, or null when it isn't valid. */
  authenticate(authorization: string | undefined): Promise<Principal | null>
}

/** One static token for a single-user install. */
export class StaticTokenAuth implements AuthProvider {
  private readonly token: Buffer
  private readonly principal: Principal

  constructor(token: string, principal: Principal) {
    this.token = Buffer.from(token)
    this.principal = principal
  }

  async authenticate(authorization: string | undefined): Promise<Principal | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    if (!m) return null
    const given = Buffer.from(m[1]!)
    if (given.length !== this.token.length || !timingSafeEqual(given, this.token)) return null
    return this.principal
  }
}

/** Reads the local token, creating it (mode 0600) the first time. */
export async function ensureTokenFile(path: string): Promise<string> {
  try {
    const token = (await readFile(path, 'utf8')).trim()
    if (token.length >= 32) {
      await chmod(path, 0o600)
      return token
    }
  } catch {
    // No token yet.
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return token
}

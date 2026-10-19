import type { AddressInfo } from 'node:net'
import { after } from 'node:test'
import { StaticTokenAuth } from '../../src/adapters/http/auth.ts'
import { createHttpServer, LOCAL_HOSTS, type HttpOptions } from '../../src/adapters/http/server.ts'
import { CaptureLogger, NB, fixtureService } from './service.ts'

export const TOKEN = 'test-token-0123456789-abcdefghijklmnop'

/** The fixture service behind a real HTTP server on a free port. */
export async function httpFixture(opts: Partial<HttpOptions> = {}) {
  const fx = await fixtureService()
  const logger = new CaptureLogger()
  const auth = new StaticTokenAuth(TOKEN, { access: { notebooks: [NB] }, person: 'Alex' })
  const server = createHttpServer({
    service: fx.service,
    auth,
    logger,
    allowedHosts: LOCAL_HOSTS,
    ...opts,
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  after(() => new Promise<void>((r) => server.close(() => r())))
  const base = `http://127.0.0.1:${port}`
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return {
      status: res.status,
      headers: res.headers,
      json: (await res.json()) as Record<string, unknown>,
    }
  }
  return { ...fx, server, port, base, call, logger }
}

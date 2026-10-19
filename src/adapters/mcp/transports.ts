// Running the MCP server: over stdio for a local agent, or over Streamable HTTP at /mcp. The
// HTTP side is stateless: each request gets its own server and transport, so any process can
// answer any request.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { NotebookService } from '../../domain/service.ts'
import type { Principal } from '../http/auth.ts'
import { buildMcpServer } from './server.ts'

export async function serveStdio(opts: {
  service: NotebookService
  principal: Principal
  version: string
}): Promise<void> {
  let name: string | undefined
  const server = buildMcpServer({ ...opts, clientName: () => name })
  // The client names itself in the MCP handshake; history records that name.
  server.server.oninitialized = () => {
    name = server.server.getClientVersion()?.name
  }
  await server.connect(new StdioServerTransport())
}

export function mcpHttpHandler(opts: { service: NotebookService; version: string }) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    body: unknown,
  ): Promise<void> => {
    const header = req.headers['x-cos-client']
    const server = buildMcpServer({
      service: opts.service,
      principal,
      version: opts.version,
      clientName: () => (typeof header === 'string' ? header : 'mcp-http'),
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

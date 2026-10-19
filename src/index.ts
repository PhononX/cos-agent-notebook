// The package's public API: the domain service, its ports, the format parser, and the local
// and in-memory adapters, and the HTTP and MCP servers.

export { NotebookService } from './domain/service.ts'
export type { ApplyChangesResult, UndoResult, CompactItem, ServiceDeps } from './domain/service.ts'
export type * from './domain/ports.ts'
export {
  checkRef,
  formatRef,
  notebookKey,
  parseRef,
  personalNotebook,
  workspaceNotebook,
  type NotebookRef,
  type Space,
} from './domain/notebook-ref.ts'
export type { Actor } from './domain/actor.ts'
export { NotebookError, type ErrorCode } from './domain/errors.ts'
export { ApplyChangesRequest, Operation } from './domain/request.ts'
export { parseNote, serializeNote, type Note, type Item, type Problem } from './format/note.ts'
export { itemId } from './format/ids.ts'
export { createLocalService, LOCAL_NOTEBOOK } from './adapters/local/index.ts'
export * as memory from './adapters/memory/index.ts'
export { createHttpServer, LOCAL_HOSTS, type HttpOptions } from './adapters/http/server.ts'
export { StaticTokenAuth, type AuthProvider, type Principal } from './adapters/http/auth.ts'
export { buildMcpServer, TOOL_NAMES } from './adapters/mcp/server.ts'
export { mcpHttpHandler, serveStdio } from './adapters/mcp/transports.ts'

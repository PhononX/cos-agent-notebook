# CLAUDE.md

`SPEC.md` is the source of truth for the design. Read it before changing behavior; if the design
changes, update `SPEC.md` in the same commit and say why. `docs/notebook-format.md` is the public
format contract (versioned); `docs/operations.md` documents `apply_changes`; `docs/spaces.md`
says what belongs in personal and workspace notebooks.

## Commands

- `npm run check`: typecheck, lint (ESLint and Prettier) and all tests. Run before every commit.
- `npm test`, or one file: `node --test test/domain/batch.test.ts`
- `npm run format` fixes formatting; `npm run build` compiles to `dist/`.
- `npm run cli -- init /tmp/nb` runs the CLI from source; `serve` and `mcp` run the local
  service (`docs/configuration.md`).
- `npm run eval` runs the agent evaluations against the Claude API (on demand, costs money);
  `npm run eval -- --ideal` replays the scenarios' ideal calls for free. See `evals/README.md`.

## Layout and conventions

- `src/format/`: pure format code (no I/O). `src/domain/`: all logic, behind `NotebookService`.
  `src/adapters/local|memory/`: implementations of `src/domain/ports.ts`. `src/adapters/http|mcp/`:
  thin servers over `NotebookService`. `src/cli/`: the command. `evals/`: agent evaluations.
- The domain layer imports no HTTP, MCP or git code; adapters stay thin.
- Notebooks are named by `NotebookRef` (space, personal or workspace, and id); local mode uses
  `personal:local:default`. Every write names one notebook; reads may cover several and label
  each result with its notebook. Spaces are stored apart; never read one notebook to write
  another.
- TypeScript runs directly under Node (type stripping): import with `.ts` extensions, no enums,
  no parameter properties, no namespaces (`erasableSyntaxOnly`).
- Errors are `NotebookError` with a code and a message that says how to fix the problem.
- Logs carry ids, counts and timings only, never note text (a test checks this). Log an error's
  code, not its message.
- No language model calls in the service; only `evals/` (test tooling) calls one. No real
  people, companies, links, tokens or keys in fixtures or examples: use invented names and
  `example.com`.
- Tests use `node:test` and `node:assert/strict`. Domain tests use the in-memory adapters with
  the fixture notebook and a fixed clock (`test/helpers/service.ts`); adapter tests use real git
  in temporary folders.
- Prettier style: no semicolons, single quotes, width 100.
- `PhononX/claude-plugins` is reference material only; never change it.

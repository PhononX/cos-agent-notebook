# cos-agent-notebook

The Chief of Staff notebook: the memory of an AI chief of staff. It keeps one person's working
world (what they owe, what they're waiting on, projects, people, decisions, ideas, links, facts,
and how they like to work) as a folder of plain Markdown with full history. Agents read and write
it through tools; people can open the files directly, for example as an Obsidian vault.

The service contains no language model and sends notebook content nowhere. Agents do the
thinking; the service keeps the structure, the rules and the history.

- [`SPEC.md`](SPEC.md): what is being built, and why. The source of truth for the design.
- [`docs/notebook-format.md`](docs/notebook-format.md): the notebook layout and line format
  (version 1), a public contract.
- [`docs/operations.md`](docs/operations.md): the `apply_changes` operations.
- [`docs/spaces.md`](docs/spaces.md): what belongs in a personal notebook and what in a
  workspace notebook.
- [`docs/configuration.md`](docs/configuration.md): settings.

## Status

Milestone 1 of 7 (format and domain core) is done:

- A parser and serializer for the format that round-trip every file byte for byte, read
  hand-edited files without failing, and report lines that don't fit.
- Item ids, derived from each line, never written into the files.
- `apply_changes` with all twelve operation kinds (`add`, `complete`, `update`, `archive`, `move`,
  `decide`, `note`, `merge`, `promote`, `set_focus`, `rule`, `log`): structured fields in,
  formatted lines out; atomic batches; dry run; idempotency keys; duplicate and close-name checks;
  provenance; one git commit per change; a daily log line per change; the notebook's time zone.
- `undo` of any earlier change, as a new change.
- Edits made directly to the files are recorded as their own change, "outside the service",
  before the next write.
- Personal and workspace notebooks: every call names one notebook by its space, and each space
  is stored apart (see "Personal and workspace notebooks" in `SPEC.md`).
- `cos-notebook init`, and `cos-notebook adopt` for a folder that already has notes (such as a
  Chief of Staff plugin `cos/` folder).

The HTTP API, MCP tools and the rest of the CLI arrive in milestone 2; see the milestones in
`SPEC.md`.

## Requirements

- Node.js 22.18 or later (the tests run TypeScript directly, using Node's type stripping)
- `git` 2.28 or later on the `PATH`

## Try it

```sh
npm install
npm run cli -- init ~/cos-notebook --timezone Europe/Berlin
```

This creates the notebook's starter files, a git repository for its history, and the first
change. Open the folder in any editor or as an Obsidian vault.

Already have notes, for example from the Chief of Staff plugin? Adopt the folder where it is:

```sh
npm run cli -- adopt path/to/cos
```

Nothing is rewritten. History starts with the notes as they are, missing starter files and the
time zone are added as a second change, and lines that don't fit the format are listed.

From code (milestone 2 puts MCP and HTTP in front of the same calls):

```ts
import { createLocalService, LOCAL_NOTEBOOK } from 'cos-agent-notebook'

const notebook = createLocalService({ dir: `${process.env.HOME}/cos-notebook` })
const actor = { client: 'my-agent', person: 'Alex', source: 'cv' }

const result = await notebook.applyChanges(
  LOCAL_NOTEBOOK,
  {
    operations: [
      { op: 'add', kind: 'action', text: 'Send the deck to Dana Whitfield', person: 'Dana Whitfield', due: '2026-10-20' },
      { op: 'decide', text: 'Team tier drops to $18 per seat', why: 'matches competitors' },
    ],
  },
  actor,
)
// result.change_id, result.results[i].items[j].id, …

await notebook.undo(LOCAL_NOTEBOOK, result.change_id!, actor)
```

With `root` instead of `dir`, one service holds many notebooks, each space in its own folder
tree (`<root>/personal/<account>/<id>/`, `<root>/workspaces/<workspace>/<id>/`):

```ts
import { createLocalService, personalNotebook, workspaceNotebook } from 'cos-agent-notebook'

const service = createLocalService({ root: '/srv/notebooks' })
await service.init(personalNotebook('alex'), { actor })
await service.init(workspaceNotebook('northwind', 'alex'), { actor })
```

## Development

| Command | What it does |
|---|---|
| `npm test` | Runs every test (`node --test`; no build needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, and Prettier in check mode |
| `npm run format` | Prettier, writing |
| `npm run check` | Typecheck, lint and test: run before every commit |
| `npm run build` | Compiles to `dist/` for publishing |
| `npm run cli -- <args>` | Runs the CLI from source |

Run one test file with `node --test test/domain/batch.test.ts`.

### Layout

```
src/
  format/        the notebook format: lines, items, front matter, ids, layout, value rules
  domain/        all the logic: NotebookService, operations, checks, ports (interfaces)
  adapters/
    local/       Markdown on disk, git history, in-process lock, file idempotency store
    memory/      in-memory ports, for tests and embedding
  cli/           the cos-notebook command
  config.ts      environment variables
test/
  fixtures/notebook/   an invented notebook covering every file type
  format/ domain/ adapters/ cli/
```

The domain layer has no HTTP, MCP or git code. It talks to the outside world only through the
interfaces in `src/domain/ports.ts`, so the same logic runs locally or hosted.

### Rules for contributions

- Fixtures and examples use invented people, companies and links (`example.com`) only. Never
  commit real notebook content, tokens or keys.
- Never put note content in logs: log ids, counts and timings. A test checks this.
- No language model calls anywhere in the service.

## License

Not chosen yet; see the open questions in `SPEC.md`.

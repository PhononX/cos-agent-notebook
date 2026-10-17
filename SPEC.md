# Chief of Staff notebook: specification

The Chief of Staff notebook is the memory of an AI chief of staff: an agent that keeps an
accurate picture of one person's working world and makes sure nothing falls through. The
service stores and organizes that picture the way a good chief of staff would: what the person
owes, what they're waiting on, their projects, people, decisions, ideas, links and facts, and
how they like to work. It is deliberately opinionated about that structure; it is not a
general-purpose memory store. Agents read and write it through MCP tools and an HTTP API. People see
it through a web dashboard, or open the files directly. The record is always a folder of plain
Markdown that the person can download, sync, or walk away with.

This document describes what to build. It is the source of truth for the service's design;
change it when the design changes.

## Why it exists

- **Memory that outlives the conversation.** Assistants forget between sessions and keep what
  they learn inside one tool. The notebook keeps it in one place any assistant can use.
- **Structure, not a pile of notes.** General memory stores keep whatever the model writes. This
  one knows what a commitment is, who it's owed to, when it went stale, and who changed it.
- **Agents organize, people stay in charge.** Agents capture and tidy; every change records who
  made it; nothing is deleted except by an explicit retention or purge rule.
- **Open and private.** Plain Markdown is the record. Nothing is locked in a database, and the
  service never sends content to an AI model.

## Principles

1. **Markdown is the record.** Everything the service knows is in the files. Indexes, caches
   and embeddings are derived from them and can be deleted and rebuilt at any time. Test: delete
   every derived store, rebuild from the folder, lose nothing.
2. **One writer.** Every change, from any client, goes through the same domain layer: the same
   checks, the same provenance, the same history.
3. **The service organizes; agents think.** The service holds schema, rules, history and
   queries. It contains no language model and makes no judgment calls. Anything that needs
   judgment (summarizing, merging, deciding an idea is now a project) is done by an agent that
   calls the service's tools.
4. **Thin adapters.** HTTP, MCP and git are adapters onto the domain layer with no logic of
   their own, so a change gets the same treatment however it arrives.
5. **One codebase, local or hosted.** The same service runs for one person on their own
   computer or for many people on a server. Hosting is added through the extension points below,
   not through forks or flags scattered through the code.

## Non-goals

- No language model inside the service, for writing, summarizing or classifying. (A local
  embedding model for search is allowed; see Search.)
- No billing, payments, plans or pricing. A hosted deployment adds those around the service.
- No agent behavior: when to capture, how to brief, how to speak. That lives in agent plugins
  that call this service.
- No integration with any specific identity provider. Authentication is generic (see Auth).

## Concepts

| Term | Meaning |
| --- | --- |
| Notebook | One person's folder of Markdown files, plus its history. The unit of storage, access and deletion. Every notebook lives in exactly one space. |
| Space | Where a notebook lives and who controls it: a person's own (**personal**), or a **workspace**'s. See "Personal and workspace notebooks". |
| Workspace | A team or company. It holds one work notebook for each member who uses one. |
| Note | One Markdown file in a notebook. |
| Item | One list line in a note (an action, a waiting item, a decision, a link…), with its fields. |
| Field | An inline `[key:: value]` on an item, or a front-matter key on a note. |
| Client | Anything that calls the service: an agent, the dashboard, a sync engine. Each has its own token and scopes. |
| Actor | Who made a change: a client, acting for a person. Recorded on every write. |
| Provenance | The `[src:: <source> <date> <link?>]` field on an item, saying where it came from. |

## Notebook format

The notebook layout and line format are defined in `docs/notebook-format.md`. Version it, and
treat it as a public contract: agents, the dashboard and people editing in Obsidian all rely on it.

Starting point: the format used by the Chief of Staff plugin in `PhononX/claude-plugins`
(`plugins/cos/skills/capture/notes-format.md`). Copy its layout, line and field rules into
`docs/notebook-format.md`, and leave out the parts that tell an agent how to behave (when to
capture, how to write briefs). In summary:

- Files: `now.md`, `brief.md`, `catch-up.md`, `nudges.md`, `inbox.md`, `actions.md`,
  `waiting.md`, `ideas.md`, `links.md`, `facts.md`, `decisions.md`; folders `projects/`,
  `areas/`, `people/`, `drafts/` (one note per name); `log/YYYY-MM-DD.md`; `archive/YYYY-MM.md`;
  and the profile files `about-me.md`, `my-rules.md`, `sources.md`.
- Items are list lines: plain sentence first, then inline fields, for example
  `- [ ] Send the deck to [[Dana Whitfield]] [due:: 2026-10-16] [src:: cv 2026-10-13]`.
  An item may carry indented `>` quote lines beneath it.
- Notes link with `[[Name]]` (Obsidian-compatible). Fields use Dataview inline syntax.
- Dates are `YYYY-MM-DD`, times are 24-hour `HH:MM`.
- Nothing is deleted in normal use: finished and stale items move to `archive/` with `why`,
  `archived` and `from` fields.

Requirements:

- **Lossless round trip.** Parsing then serializing an unchanged file gives back identical
  bytes. Edits change only the lines they touch.
- **Tolerant reading, strict writing.** Files people edit by hand may not fit the format. The
  service reads them without failing, shows what it can, and reports lines it can't parse. Its
  own writes are always valid.
- **Item ids.** Every item has a short id (6 characters) derived from its note path and exact
  text, plus an occurrence number when identical lines repeat. Ids are not written into the
  files, so they stay clean for people. An id stays the same until that line changes; every
  write returns the new id. A write that targets an id that no longer exists is refused with
  the item's current text, never applied to whatever line is there now.

## Personal and workspace notebooks

A person can have a personal notebook and, for each workspace they belong to, a separate work
notebook in that workspace. Each one is a complete notebook in the same format, with its own
history: someone in two workspaces has three notebooks, one per space, kept apart.

- **What goes where** is defined in `docs/spaces.md`: whose business is it, the company's or
  the person's? It lists what workspaces keep (confidential business, customers, work product,
  work commitments, colleagues in their role, others' HR matters) and what is the person's and
  travels with them (themselves, their career and own employment, their relationships as people,
  general know-how). When an item doesn't clearly pass the test, the agent asks the person; the
  channel it came through is a hint, never the decision. The person's own rules and the
  workspace's rules win over these defaults.
- **Naming.** A notebook is named by its space and its id: `personal:<account>:<id>` (the id is
  usually `default`) or `workspace:<workspace>:<member>`. Each part is a lowercase id.
- **Storage is segmented by space.** Each space's notebooks are stored apart: locally under
  `personal/<account>/<id>/` and `workspaces/<workspace>/<id>/`. A deployment can put each
  space on its own volume or bucket, encrypt each with its own key, and give each its own
  retention, backup and deletion. Every interface below receives the notebook's space.
- **The person controls their personal notebook.** Only they, and the clients they authorize,
  can read or change it. No workspace token, admin or job ever reaches it.
- **The workspace controls its work notebooks.** The member reads and writes theirs day to day.
  Workspace admins set retention, and can export or delete a work notebook. A work notebook stays
  with the workspace when the member leaves, and the member loses access to it.
- **Mistakes in a work notebook are the workspace's to purge.** If something personal is filed
  in a work notebook, the member can archive or correct it like any item, but only a workspace
  admin can purge it from history, as with personal mail sent to a work address. A member who
  could purge their own items could also clear work records, so they can't. This is why the
  agent asks when an item's side isn't clear.
- **Notebooks never move between spaces.** A work notebook is created in its workspace and
  stays there; a personal notebook can't be moved into a workspace, or a work notebook out to a
  person or into another workspace. Joining a new workspace starts a new, empty notebook there.
- **The personal notebook knows everyone.** It has a person note for everyone the person deals
  with in any space. For someone known mainly outside work it's the full record. For a colleague
  it can be a short entry that points, with `same_as`, to their note in each work notebook:
  `same_as: workspace:northwind:alex/Dana Whitfield | workspace:fernhill:alex/D. Whitfield`.
  Each note grows with what comes in through its own space: what's learned at work goes into the
  work note, what's learned outside work into the personal note. A personal entry can grow into
  a full record, or stay just a name and a pointer. Links live only in the personal notebook:
  work notebooks never point to a personal notebook or to another workspace, so no workspace
  learns about the person's other spaces. The service checks each link's form (it must point to
  a work notebook), never follows it into another notebook, and offers a lookup
  (`findLinkedPeople`) so an agent reading a work note can find the personal one. The lookup
  returns only the links to the notebook asked about, so it never reveals the person's other
  spaces. Keeping the personal notebook complete is the agent's job, one call per notebook.
  Links are for people only for now.
- **One notebook per call.** Every read and write names exactly one notebook. No operation reads
  one notebook to write another, moves or copies items between them, or checks names across
  them. A client with access to both (an agent working for a person at work) calls each
  separately; deciding whether something is work or personal is the agent's judgment, made with
  the person.
- **Deletion follows control.** Deleting a workspace deletes its notebooks. Deleting a person's
  account deletes their personal notebook; their work notebooks follow each workspace's policy.

## Architecture

```
  Dashboard ──HTTP──┐
  Agents ─────MCP───┼──► Domain layer ──► Storage (Markdown + git history)
  Sync engine ─git──┘     (schema, rules,      │
                           lifecycle, history,  └─► Derived indexes (search, backlinks)
                           queries, profile)
```

### Domain layer (all the logic)

- **Schema and checks.** Validate every write against the format. Refuse malformed writes with
  a clear reason; set aside malformed lines that arrive by sync in a review note rather than
  dropping them.
- **Lifecycle.** Items are open, then done or stale, then archived with a reason.
- **Provenance and actor.** Add `[src:: …]` when a write lacks it. Record the actor on every
  change.
- **History.** Every successful write is one git commit: author = the actor, message = a
  one-line summary of the change, ending with a `Cos-Change: <change id>` trailer. Change ids
  (`ch_` and 8 characters) are the service's own rather than commit hashes, so they survive
  retention and purge rewriting history. Writes to one notebook are serialized.
- **Edits made outside the service.** People edit the files directly (in Obsidian, say). Before
  each write and each undo, under the notebook lock, the service records any notes changed
  outside it as their own change, authored "outside the service", with a daily log line naming
  the files; the caller's change follows as a separate commit. The edits are recorded exactly as
  they are, including lines that don't fit the format. This keeps every commit to what its
  author did, and lets agents see changes made by others.
- **Daily log.** Each write appends a short line to `log/YYYY-MM-DD.md` saying what changed and
  who did it (`[by:: …]`) with its change id (`[change:: …]`), so agents reading the log see
  changes made by people and other agents.
- **Review candidates.** Computed without AI: items untouched for N days (from `stale_days` in
  `my-rules.md`), likely duplicates (normalized text similarity), ideas mentioned several times,
  waiting items never nudged, actions past due.
- **Profile.** Combine the defaults, `about-me.md` and `my-rules.md` (rules win) into one
  profile that agents load at the start of a session.
- **Time zone.** Each notebook has a time zone (`timezone` in `my-rules.md` front matter;
  local mode defaults to the computer's). "Today", "overdue", "stale" and which daily log a
  change goes in are all computed in that zone.

### Storage and history

- One git repository per notebook. Git is the open-source version-control tool and protocol,
  not GitHub; repositories live on the service's own storage. People never need to know it's
  there.
- Use the system `git` binary. Plumbing commands are fine.
- **Retention:** a scheduled job keeps every commit from the last N days (configurable per
  space, default 90) and collapses everything older into one starting commit:
  1. `git rev-list -1 --before=<cutoff> main`
  2. `git commit-tree <cutoff>^{tree}` → new parentless root
  3. `git rebase --onto <new-root> <cutoff> main --committer-date-is-author-date`
  4. `git reflog expire --expire=now --all && git gc --prune=now`
- **Purge:** remove a file, or replace text, across all history (for example, a password
  captured by mistake), then the same cleanup as step 4.
- **Delete notebook:** removes the repository, derived indexes and any cached copies.

### Search

Three layers, ranked together:

1. **Structured filters:** person, project, area, file, status, field values, date range.
2. **Keyword:** full-text search across every note.
3. **Semantic (optional, off by default):** a small embedding model running inside the service
   process or on the same host. No content leaves the service. Embeddings are derived data:
   rebuilt from the files, and deleted with the notebook.

## Designing for agents

Agents are the main users of this service, so the tool interface is designed around how an
agent actually works in a conversation, not around the files. A typical exchange: the agent
starts a session, hears something that produces several items at once (a decision, an action,
news about a person), may mishear a name from a voice transcript, may retry after a timeout,
and must ask the person before reorganizing anything.

1. **One call to start a session.** `start_session` returns everything an agent needs to begin:
   the combined profile, today's date and weekday in the notebook's time zone, the filing rules
   for this notebook's space (from `docs/spaces.md` and any rules of its own), current focus,
   reminders to raise, counts of open, due and overdue items, and changes made by others
   (people on the dashboard, other agents) since this client's last session.
2. **One call per exchange.** `apply_changes` takes a list of operations and applies them
   atomically as one commit: all succeed or none do. An exchange that files a decision, an
   action and a person update is one call and one history entry.
3. **Structured fields in, formatted lines out.** Agents pass text, person, project, due date,
   source and so on as separate fields. The service writes the `[[links]]` and `[key:: value]`
   fields. Agents never format lines by hand.
4. **Address items by id or by text.** Every read returns item ids. An operation can instead
   name an item by a phrase (`"match": "send the deck to Dana"`, optionally limited to a file).
   If the phrase matches no item or more than one, the whole call is refused and the response
   lists the candidates with their ids. This also works for agents that read the files directly
   and have no ids.
5. **Names are checked.** A person, project or area name that is close to an existing one but
   not the same ("Dana Whitfeld") is refused with the closest matches, so transcription errors
   don't create duplicate people. A genuinely new name is accepted and reported as new.
   `resolve_names` looks names up ahead of time. When a close name really is someone new, the
   agent repeats the call with that name in `confirm_new_names`.
6. **Retries are safe.** `apply_changes` accepts an `idempotency_key`; repeating a key within 24
   hours returns the first result; the same key with a different request is refused, so a reused
   key never hides a different change. Adding an open item whose normalized text matches an open
   item in the same file returns the existing item, marked `duplicate`, instead of adding another.
7. **Preview before reorganizing.** `apply_changes` accepts `dry_run: true` and returns exactly
   what would change, as before and after lines, without writing. Agents use it to show the
   person a merge, promotion or archive before asking. The preview leaves out the daily log
   line, which only a real change adds.
8. **Undo.** `undo` reverts one earlier change by its change id (a new commit, so history is
   kept). Every write returns its change id. Daily log lines are kept, and a new one records the
   undo. When later changes touched the same lines, undo is refused and names the files.
9. **Dates are absolute.** Tools take `YYYY-MM-DD` dates; the agent turns "Friday" into a date
   using the date `start_session` returned. The service never guesses.
10. **Reads fit in a context window.** Every read takes `limit` (default 50) and returns a
    `cursor` for more. Items come back compact: `{id, file, text, done, fields, links}`. A whole
    note is returned only by `read_note`, which can be limited to named sections.
11. **Errors say how to fix them.** Every refusal names the problem and the next step: "No
    item matches 'deck for Dana' in actions.md. Closest: a3f9k2 'Send the v3 pricing deck to
    Dana Whitfield'."
12. **Few tools, well described.** MCP clients load every tool description into the agent's
    context, so the set is kept to about a dozen, with similar operations grouped as kinds of
    one tool. Each description says when to use the tool, with an example call, and is enough
    for an agent with no other instructions.
13. **Content is data.** Notebook text may contain instructions planted by someone else (in a
    quoted email, say). Tool results return content in clearly marked fields, never as text
    addressed to the agent.

## Interfaces

### MCP

Serve MCP over Streamable HTTP at `/mcp`, and over stdio for local use (`cos-notebook mcp`). Use the
official MCP TypeScript SDK.

**Read tools**

| Tool | Purpose |
| --- | --- |
| `start_session` | Profile, today's date in the notebook's time zone, focus, reminders, open-item counts, changes by others since this client's last session |
| `get_items` | Items of one or more kinds (`action`, `waiting`, `idea`, `link`, `fact`, `decision`, `inbox`, `catch_up`), filtered by person, project, area, status, due before or after, untouched for N days |
| `read_note` | One note (person, project, area, draft, brief, profile file…), optionally limited to sections, with item ids |
| `search` | Filters, keyword and (when enabled) semantic search; compact results with ids |
| `resolve_names` | Closest existing people, projects and areas for one or more names, with scores |
| `get_review_candidates` | Stale, duplicate, recurring, never-nudged and overdue items |
| `get_changes` | Changes since a time, change id or cursor, with actors |

**Write tools**

| Tool | Purpose |
| --- | --- |
| `apply_changes` | The main write tool. A list of operations, applied atomically as one commit, with `idempotency_key` and `dry_run`. Operation kinds below |
| `write_brief` | Start or add today's brief: its name, sent time, sections and numbered follow-ups with drafts |
| `update_catch_up` | Add or update catch-up lines by thread link (raising `raised` each time it's mentioned), or close them with a reason |
| `save_draft` | Save a new version of a draft, keeping the previous one in `drafts/.history/` and adding a history line |
| `clear_nudges` | Remove reminders once they've been raised |
| `undo` | Revert one earlier change by its change id |

**`apply_changes` operation kinds**

| Kind | Does |
| --- | --- |
| `add` | New item of a kind, from structured fields (`text`, `person`, `project`, `area`, `due`, `since`, `back`, `why`, `src`, `quote`) |
| `complete` | Check off an action or waiting item, adding `done` |
| `update` | Change an item's text or fields |
| `archive` | Move an item to `archive/YYYY-MM.md` with `why` |
| `move` | Attach an item to a project or area, or move it to another file |
| `decide` | Append a decision; optionally mark an earlier one `superseded` |
| `note` | Create a person, project or area note, set front-matter fields (`last_talked`, `status`), or append to a section |
| `merge` | Combine duplicate items into one, keeping every `src`; the others are archived with `why:: merged` |
| `promote` | Turn an idea into a project note, moving the idea's line into it |
| `set_focus` | Replace the focus or this week's dates in `now.md`, or add a suggested move |
| `rule` | Add or change a rule in `my-rules.md`; needs the `rules:write` scope |
| `log` | Add a line to today's daily log |

Every write returns, per operation: the item ids, the lines as written, any warnings (new
names, likely duplicates), and the change id.

### HTTP API

JSON over HTTPS, versioned under `/v1`. The same operations as MCP (`apply_changes` is
`POST /v1/notebooks/<ref>/changes`, where `<ref>` is the notebook's name such as
`workspace:northwind:alex`), plus what the dashboard needs: list notes, read a note, the dashboard's data bundle, change feed. All write routes
require `Content-Type: application/json`. Publish an OpenAPI description.

### Git endpoint

Serve smart HTTP at `/git/<ref>.git` (via `git http-backend`). Off unless enabled for a
notebook. Read-only by default; push is a separate scope. A push is processed like any other
write: changed lines are validated, tagged as the person's, merged line by line, and lines
changed on both sides are flagged as conflicts in a review note. The server's copy is
authoritative.

### Export

`GET /v1/notebooks/<ref>/export` returns a zip of the Markdown files (no git metadata).

### Dashboard

A web page served by the service at `/`, built only on the HTTP API with no privileged access.
It shows today, actions, waiting, projects, people, ideas, links and facts, decisions, the
daily log and the archive. It allows checking items off, adding items and editing notes.
Starting point: the notebook page in `PhononX/claude-plugins`
(`plugins/cos/templates/dotcos/brain-template.html`) and the edit operations in
`plugins/cos/templates/dotcos/notebook-server.mjs` (toggle, replace, add, create, write).

### Sync engine

A command-line client (`cos-notebook sync <url> <folder>`) that keeps a local folder current for
Obsidian, offline use and fast agent reads:

- Pull when the server reports a change (server-sent events from `/v1/notebooks/<ref>/events`),
  or poll as a fallback.
- Commit and push local edits after a short pause (default 5 seconds).
- Fetch only the retention window (`--shallow-since`). When the server has rewritten history
  (retention or purge), re-fetch and re-apply unpushed local edits.
- Report conflicts the server flagged; never resolve them silently.

## Auth

Authentication is pluggable; the service ships two providers:

- **Local:** one static token in a file with mode 0600, for single-user installs. The HTTP and
  MCP endpoints bind to `127.0.0.1` by default, and check `Host` and `Origin` against a
  configured allow-list (to block DNS rebinding; add a Tailscale hostname here, for example).
- **OAuth resource server:** validates bearer tokens from a configured authorization server
  (JWT with JWKS, or token introspection), following the MCP authorization spec, including
  protected resource metadata. Maps the token's subject to an account.

On top of either, the service issues its own **notebook tokens**: opaque, one per client or
device and notebook, stored hashed, scoped, revocable, and listed in the dashboard. A token's
scopes apply to its one notebook. A client that serves a person at work and at home holds one
token for each notebook. Scopes:

| Scope | Allows |
| --- | --- |
| `notebook:read` | All read tools and routes |
| `notebook:write` | Item and note writes |
| `rules:write` | Changing `my-rules.md` |
| `sections:<name>` | Limits reads to named sections, such as excluding `catch-up` and `people` |
| `git:read`, `git:write` | Clone and push |
| `admin` | Token management, retention, purge, delete, for one notebook. On a personal notebook only the person holds it |
| `workspace:admin` | Retention, export and delete for every work notebook in one workspace. Never valid for a personal notebook |

## Extension points for hosting

A hosted deployment (a separate, private repository) runs this service as a dependency and
plugs in through these interfaces. Define each as a small typed interface with the local
implementation in this repository.

| Interface | Local implementation | What a hosted deployment provides |
| --- | --- | --- |
| `NotebookStore` | Folders on local disk, one tree per space | Per-space volumes or object storage: each person's personal space and each workspace apart |
| `KeyProvider` | None (disk encryption is the OS's job) | Per-space or per-notebook keys from a KMS; deleting a key makes all copies of what it covers unreadable |
| `AuthProvider` | Static token | OAuth with the hosted identity provider |
| `Lock` | In-process mutex per notebook | Distributed lock, so several instances can serve one notebook safely |
| `AccessLog` | Append-only file per notebook | Central store; shown to the person as "who read and changed what", and for work notebooks to workspace admins |
| `Entitlements` | Unlimited | Quotas (storage, clients, features) per space, checked before writes; returns a clear "limit reached" error |
| `EventBus` | In-process | Cross-instance change notifications for the sync engine and dashboard |

Hosting also needs these properties throughout the code:

- **Every route, tool and job is scoped to one notebook**, named by its space and id. Local
  mode has one notebook, `personal:local:default`.
- **Stateless processes.** All state lives behind `NotebookStore`, `Lock` and the derived
  indexes, so instances can be added or replaced.
- **No content in logs.** Logs, errors and metrics carry ids, counts and timings, never note
  text. Add a test that fails if a known string from a test notebook appears in the logs.
- **Configuration from environment variables** (with an optional file), documented in one
  place.
- **Health and readiness endpoints** (`/healthz`, `/readyz`).

## Security

- Validate every path: inside the notebook, `.md` only, no `..`, no hidden folders.
- Write atomically (temp file and rename) under the notebook lock.
- Limit request bodies (default 2 MB) and rate-limit per token.
- Never store passwords or keys in a notebook; refuse writes that match common secret patterns
  and say why.
- Treat notebook content as untrusted data in every response: it may contain text written to
  manipulate an agent. Tool results return content as data, never as instructions.

## Technology

- TypeScript on Node.js (current LTS). Keep runtime dependencies few and well known.
- The official MCP TypeScript SDK.
- The system `git` binary.
- Search: SQLite with FTS5 for filters and keywords; an optional local embedding model behind
  an interface.
- Tests: unit tests for the format parser (round-trip on a fixture notebook), the domain layer
  and every tool; an end-to-end test that runs the service, connects an MCP client, writes, and
  checks the git history and daily log.
- **Agent evaluations** (test tooling, not part of the service): scripted conversations, each
  with the notebook state it should produce, replayed through a real agent connected over MCP.
  Measure tool calls per exchange, refused calls, duplicates created, items filed in the wrong
  place and tokens read. Run them before each milestone is called done, and use the results to
  change tool shapes and descriptions. They call a model, so they run on demand, not in CI.
- Repository and package name: `cos-agent-notebook` (published to npm, so installers can fetch
  it). The command it installs is `cos-notebook`.
- One CLI: `cos-notebook serve`, `cos-notebook mcp` (stdio), `cos-notebook sync`, `cos-notebook init`,
  `cos-notebook token create|list|revoke`, `cos-notebook retention run`, `cos-notebook export`.

## Milestones

1. **Format and domain core.** `docs/notebook-format.md`; parser and serializer with lossless
   round trip; validation; item ids; the `apply_changes` operations from structured fields,
   atomic, with dry run, idempotency, duplicate and name checks; provenance; git commit per
   change; undo; daily log; time zone. A fixture notebook with every file type.
2. **Local service.** HTTP API, local auth with Host and Origin checks, MCP over stdio and
   Streamable HTTP with the full tool set, and the first agent evaluations.
3. **Dashboard.** Port the existing notebook page onto the HTTP API.
4. **Search and review.** Filters, keyword search, review candidates, change feed.
5. **Openness.** Export, git endpoint, sync engine, retention, purge.
6. **Ready to host.** Multi-notebook routing across personal and workspace spaces, the
   `workspace:admin` scope, notebook tokens and scopes, OAuth resource-server
   mode, the extension-point interfaces, access log, no-content-in-logs test.
7. **Semantic search** (optional module).

Each milestone ends with passing tests and an updated README section on how to run it.

## Open questions

- History storage: git inside the service (current plan), or current files plus a database
  change log, with git used only for export.
- Retention defaults: 30 or 90 days of individual changes; how long archived items are kept.
- Which local embedding model to use, and at what notebook size semantic search is worth
  enabling by default.
- License: AGPL (prevents a closed hosted copy) or MIT/Apache (wider adoption).
- Whether a member leaving a workspace may take an export of their work notebook (a workspace
  setting?).
- Whether workspaces will later want shared notebooks written by a whole team. Today every
  notebook is one person's.

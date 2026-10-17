# apply_changes operations

`apply_changes` is the main write. It takes a list of operations and applies them as one change
to one notebook: all of them or none, one history entry, one line in the daily log. The notebook
is named by its space and id (`personal:alex:default`, `workspace:northwind:alex`); a call never
touches any other notebook, so ids, change ids, names and idempotency keys belong to the
notebook they came from. This page is the reference for
the domain layer (`NotebookService.applyChanges`); the MCP tool and HTTP route in milestone 2 take
the same JSON.

```json
{
  "operations": [
    { "op": "decide", "text": "Team tier drops to $18 per seat", "person": "Dana Whitfield", "why": "matches competitors" },
    { "op": "add", "kind": "action", "text": "Send Dana the new tier sheet", "person": "Dana Whitfield", "due": "2026-10-20" },
    { "op": "note", "type": "person", "name": "Dana Whitfield", "front_matter": { "last_talked": "2026-10-17" } }
  ],
  "idempotency_key": "conv-41-turn-7",
  "dry_run": false,
  "confirm_new_names": []
}
```

| Field | Meaning |
|---|---|
| `operations` | 1 to 50 operations, applied in order. A later operation sees what earlier ones did, and can still use ids read before the call. |
| `idempotency_key` | Optional, 8 to 200 characters. Repeating a key within 24 hours returns the first result (`replayed: true`) without writing again. The same key with a different request is refused. |
| `dry_run` | Return exactly what would change, as before and after lines, without writing. The daily log line a real call adds is left out of the preview. |
| `confirm_new_names` | Names to accept as new even though they're close to an existing name (see Names). |

## The result

```json
{
  "change_id": "ch_7k2m9qxa",
  "dry_run": false,
  "replayed": false,
  "summary": "Decided \"Team tier drops to $18 per seat with [[Dana Whitfield]]\"; Added …",
  "results": [
    {
      "index": 1,
      "op": "add",
      "status": "added",
      "items": [{ "id": "a3f9k2", "file": "actions.md", "line": "- [ ] Send [[Dana Whitfield]] the new tier sheet [due:: 2026-10-20] [src:: cv 2026-10-17]" }],
      "changes": [{ "file": "actions.md", "before": [], "after": ["- [ ] Send [[Dana Whitfield]] the new tier sheet [due:: 2026-10-20] [src:: cv 2026-10-17]"] }],
      "warnings": []
    }
  ],
  "new_names": [],
  "files": [{ "path": "actions.md", "status": "changed" }],
  "warnings": []
}
```

- `change_id` is null when nothing changed (a dry run, or only duplicates). Pass it to `undo`.
- Each item comes back with its new `id`, and `previous_id` when an existing line changed. `id`
  is null when a later operation in the same call changed the line again.
- `status` is one of `added`, `duplicate`, `completed`, `updated`, `archived`, `moved`,
  `created`, `merged`, `promoted`, `logged`, `unchanged`.
- Warning codes: `new_name`, `duplicate`, `likely_duplicate`, `already_done`,
  `already_superseded`, `existing_project`, `timezone_invalid`, `dry_run`.

## Refusals

A refused call writes nothing. The error has a `code`, a `message` that says how to fix it, the
`operation` index, and data to retry with:

| Code | When | Data |
|---|---|---|
| `invalid_request` | The JSON doesn't fit (unknown field, missing field, unknown operation) | `issues` |
| `invalid_value` | A value doesn't fit the format (a date that isn't `YYYY-MM-DD`, text with `[key:: value]` in it, a name with `/`) | |
| `not_found` | No item has that id, or no item matches the phrase | `candidates` (closest items with ids) |
| `ambiguous` | The phrase matches more than one item | `candidates` |
| `stale_id` | The id's line changed since it was read | `was` (the old text), `now` (the item it became, with its id) |
| `close_name` | A name is close to an existing one but not the same | `name`, `matches` with scores |
| `secret` | Text looks like a password, access code or key | `secret_kind` |
| `forbidden` | The client lacks a scope (`rules:write` for `my-rules.md`) | |
| `idempotency_mismatch` | The key was used for a different request | |
| `not_a_notebook` | No notebook with that id | |

## Common fields

- **Names:** `person` (one name or a list), `project`, `area`. The service links each name inside
  the sentence where it appears (`Send the deck to Dana Whitfield` → `[[Dana Whitfield]]`; a
  person's first name alone counts when it appears once), and otherwise adds it at the end:
  `for [[Q4 Launch]]`, `with [[Dana Whitfield]]`. An existing name written differently
  (`dana whitfield`) uses the existing spelling. A name close to an existing one but not the same
  (`Dana Whitfeld`, or just `Dana`) is refused with the closest matches; if it really is someone
  new, repeat the call with the name in `confirm_new_names`. Genuinely new names are accepted and
  listed in `new_names`.
- **Dates** are always `YYYY-MM-DD`. Turn "Friday" into a date first.
- **`src`** is where the information came from: `cv`, `gmail 2026-10-12`, or
  `gmail 2026-10-12 https://mail.example.com/…`. Today's date is added when there's none. Without
  `src`, the client's default source is used (`page` for the dashboard, `agent` otherwise).
- **Addressing an item:** `id` from a read, or `match` with a phrase from the item, optionally
  limited to one `file`. Phrases ignore case, punctuation and link brackets. Without `file`, a
  phrase searches every note except the log, the archive and `brief.md`.
- **Text** is one plain sentence. Pass fields as separate values; never type `[key:: value]` or
  list markers. Extra lines go in `quote` (a string with newlines, or a list).

## Operations

### add

A new item of a kind, in its file.

| Kind | Goes to | Notes |
|---|---|---|
| `action` | `actions.md`, under "To do" | checkbox; `due` |
| `waiting` | `waiting.md` | checkbox; needs `person`, who leads the line; `since` defaults to today |
| `idea` | `ideas.md` | `back`: when to bring it back, in words or a date |
| `link` | `links.md` | needs `url`; `text` is the link's label |
| `fact` | `facts.md` | pass `file` to put it in a person's or project's note |
| `inbox` | `inbox.md` | |
| `catch_up` | `catch-up.md`, in the section for `fields.kind` | needs `fields.kind`: `reply`, `missed` or `changed`; `since` defaults to today |
| `decision` | `decisions.md` | the same as `decide` |

Fields: `kind`, `text`, `person`, `project`, `area`, `due`, `since`, `back`, `why`, `url`, `src`,
`quote`, `file`, `section`, and `fields` for any other field (`nudged`, `raised`, `prep`…).
An open item in the same file with the same text (ignoring case, punctuation and links) is
returned instead, with status `duplicate`. Similar items are listed in a `likely_duplicate`
warning.

```json
{ "op": "add", "kind": "waiting", "text": "the engineering estimate", "person": "Priya Natarajan", "src": "slack" }
```

### complete

Checks off an action or waiting item and adds `done` (today, or `date`).

```json
{ "op": "complete", "match": "reply to Jordan", "file": "actions.md" }
```

### update

Changes an item's `text`, links (`person`, `project`, `area`), `done` (true or false), `fields`
(a value sets a field, `null` removes it) or `quote` (`null` removes it). A waiting item keeps its
person first; a dated line keeps its date. Decisions can't be edited, and `src` can't be changed.

```json
{ "op": "update", "id": "a3f9k2", "fields": { "due": "2026-10-24", "nudged": "2026-10-17" } }
```

### archive

Moves an item and its quote lines to `archive/YYYY-MM.md` (this month), adding `archived`, `why`
and `from`. Decisions aren't archived; they're superseded.

```json
{ "op": "archive", "id": "a3f9k2", "why": "no longer needed" }
```

### move

With `project` or `area` (or `person`) only: links the item to it, where it stays. With
`to_file`: moves the item there (into `section`, or the file's usual section; a project or area
note's "Notes"), adding or removing the checkbox to suit the file. The target note must exist:
create a person, project or area note first with `note`, earlier in the same call.

```json
{ "op": "move", "match": "Stripe invoice format", "to_file": "projects/Q4 Launch.md" }
```

### decide

Appends a decision to `decisions.md`, dated today (or `date`), with `why`. `supersedes` names an
earlier decision (`id` or `match`) to mark `superseded`.

```json
{ "op": "decide", "text": "SSO ships Oct 22", "person": "Priya Natarajan", "why": "two blockers", "supersedes": { "match": "SSO ships Oct 15" } }
```

### note

Creates a person, project or area note (`type` and `name`), or changes an existing note (`file`,
such as `about-me.md`). `front_matter` sets keys (`null` removes one); `append` adds lines, as
strings or `{ text, person, project, area, src, quote }`, at the end of `section` (created if
missing) or of the note. A new project gets `status: active`. `my-rules.md` is changed with `rule`.

```json
{ "op": "note", "type": "person", "name": "Sam Okafor", "front_matter": { "role": "Recruiter" }, "append": ["Runs the Senior PM search"] }
```

### merge

Combines duplicates into the first item: every `src` is kept, missing fields and quote lines are
copied over, and `text` can replace the sentence. The other items are archived with
`why:: merged`.

```json
{ "op": "merge", "items": [{ "id": "a3f9k2" }, { "id": "k7m2p9" }] }
```

### promote

Turns an item (usually an idea) into a project: creates `projects/<project>.md` if needed (with
`front_matter`) and moves the item into its "Notes" section.

```json
{ "op": "promote", "match": "referral program", "file": "ideas.md", "project": "Referral program" }
```

### set_focus

Changes `now.md`: `focus` replaces the Focus lines (at most 3), `this_week` replaces this week's
dates (`{ date, text }`, sorted by date), `suggest` adds a suggested move.

```json
{ "op": "set_focus", "focus": ["Close the Acme renewal"], "suggest": "Make the referral idea a project?" }
```

### rule

Changes `my-rules.md`, which needs the `rules:write` scope: `text` adds a rule to `section`
(default "My rules") with optional `replaces` and `fields`; `id` or `match` with `text`,
`replaces` or `fields` changes a rule; `settings` changes front matter (`timezone`,
`nudges_per_day`, `stale_days`, `meeting_prep`).

```json
{ "op": "rule", "settings": { "stale_days": 14 } }
```

### log

Adds a line to today's daily log, with the time and who wrote it.

```json
{ "op": "log", "text": "Talked through pricing with Dana", "person": "Dana Whitfield" }
```

## undo

`undo(notebook, change_id)` reverts one change as a new change, so history keeps both. Daily log
lines are kept, and a new one records the undo. When later changes touched the same lines, undo is
refused and names the files; make the reverse change with `apply_changes` instead.

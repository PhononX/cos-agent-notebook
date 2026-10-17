# Configuration

Every setting is an environment variable. They are read in one place, `src/config.ts`. A
configuration file comes with the local service in milestone 2.

| Variable | Default | Meaning |
|---|---|---|
| `COS_NOTEBOOK_DIR` | `~/cos-notebook` | The local notebook's folder. `cos-notebook init <folder>` overrides it. |
| `COS_NOTEBOOK_TIMEZONE` | The computer's time zone | The time zone for a notebook whose `my-rules.md` doesn't set `timezone`, and the one `init` writes there. An IANA name like `Europe/Berlin`. |
| `COS_NOTEBOOK_LOG_LEVEL` | `info` | `info` logs every call; `warn` logs only problems. Logs are JSON lines on stderr and carry ids, counts and timings, never note text. |

The notebook's own settings (`timezone`, `stale_days`, `nudges_per_day`, `meeting_prep`) live in
the front matter of its `my-rules.md`; see `docs/notebook-format.md`.

## Files the service keeps in a notebook folder

| Path | What it is |
|---|---|
| `.git/` | The notebook's history: one commit per change. |
| `.cos-notebook/` | Service state that can be deleted at any time (idempotency records). Never committed or exported. |

# Configuration

Every setting is an environment variable. They are read in one place, `src/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `COS_NOTEBOOK_DIR` | `~/cos-notebook` | The local notebook's folder. `cos-notebook init <folder>` overrides it. |
| `COS_NOTEBOOK_TIMEZONE` | The computer's time zone | The time zone for a notebook whose `my-rules.md` doesn't set `timezone`, and the one `init` writes there. An IANA name like `Europe/Berlin`. |
| `COS_NOTEBOOK_LOG_LEVEL` | `info` | `info` logs every call; `warn` logs only problems. Logs are JSON lines on stderr and carry ids, counts and timings, never note text. |
| `COS_NOTEBOOK_PERSON` | None | The person agents act for. History and the daily log then say `claude-code for Alex` instead of `claude-code`. One line, no brackets. |
| `COS_NOTEBOOK_HOST` | `127.0.0.1` | The address `cos-notebook serve` listens on. `--host` overrides it. Anything other than a loopback address lets other computers reach the service, with the token. |
| `COS_NOTEBOOK_PORT` | `4317` | The port `serve` listens on. `--port` overrides it; `0` picks a free one. |
| `COS_NOTEBOOK_ALLOWED_HOSTS` | None | Host names allowed in a request's `Host` and `Origin` headers besides `127.0.0.1`, `localhost` and `::1`, separated by commas, like `notebook.tail1234.ts.net`. Requests naming any other host are refused, which blocks DNS rebinding from web pages. |
| `COS_NOTEBOOK_TOKEN_FILE` | `.cos-notebook/token` in the notebook folder | The local token. `serve` creates it the first time (32 random bytes, readable only by you) and checks its mode on every start. |

## The local service

`cos-notebook serve [folder]` serves one notebook, `personal:local:default`:

- the HTTP API under `/v1`, described at `/v1/openapi.json`;
- MCP over Streamable HTTP at `/mcp` (stateless; JSON responses);
- `/healthz` and `/readyz`, which need no token.

Every other request needs `Authorization: Bearer <token>` with the token from the token file.
Request bodies are limited to 2 MB and each token to 20 requests a second (short bursts are
allowed). Clients name themselves with an `X-Cos-Client` header (letters, digits, dots, dashes,
underscores); history records that name, with the person.

`cos-notebook mcp [folder]` serves MCP over stdio, for an agent that starts its own MCP servers.
It needs no token, because only the program that started it can talk to it, and takes the
client's name from the MCP handshake. For example, in an MCP client's configuration:

```json
{ "command": "cos-notebook", "args": ["mcp", "/home/alex/cos-notebook"], "env": { "COS_NOTEBOOK_PERSON": "Alex" } }
```

`serve`, `mcp`, the CLI and someone editing the files can all use one notebook at once: writes
take turns through the notebook's lock file, and edits made directly to the files are recorded
before the next write.

The notebook's own settings (`timezone`, `stale_days`, `nudges_per_day`, `meeting_prep`) live in
the front matter of its `my-rules.md`; see `docs/notebook-format.md`.

## Where notebooks live on disk

`cos-notebook init` and `COS_NOTEBOOK_DIR` give one folder for one notebook,
`personal:local:default`. Code that serves several notebooks passes a `root` instead
(`createLocalService({ root })`), and each space gets its own folder tree:

```
<root>/personal/<account>/<id>/        a person's own notebooks (usually id "default")
<root>/workspaces/<workspace>/<member>/ a workspace's work notebooks, one per member
```

Each notebook folder is a complete notebook with its own git history, so a space can be backed
up, moved or deleted without touching another.

## Files the service keeps in a notebook folder

| Path | What it is |
|---|---|
| `.git/` | The notebook's history: one commit per change. |
| `.cos-notebook/` | Service state that can be deleted at any time: idempotency records, the last session per client, `token` (the local token; deleting it makes `serve` create a new one, and clients need the new one), and `lock`, held while a change is being written so two programs never write at once. Never committed or exported. |

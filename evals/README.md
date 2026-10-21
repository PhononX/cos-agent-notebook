# Agent evaluations

Scripted conversations replayed through a real agent connected to the notebook over MCP, to see
whether the tools work for an agent with no other instructions (see "Designing for agents" and
"Technology" in `SPEC.md`). This is test tooling: the service itself never calls a model.

```sh
npm run eval                                   # every scenario once, with claude-opus-5-5
npm run eval -- --scenario misheard-name --runs 5
npm run eval -- --effort high --model claude-sonnet-5-5
npm run eval -- --ideal                        # no model: replay the ideal calls, free
npm run eval -- --keep                         # keep each run's notebooks to look at
```

It calls the Claude API, so it needs credentials (`ANTHROPIC_API_KEY`, or a profile from
`ant auth login`) and costs money; it runs on demand, never in CI. Server-side refusal fallbacks
are on unless `--no-fallbacks`; the model that actually answered is recorded in the results.

Each run starts from fresh notebooks on disk (`notebooks.ts`: Alex's personal notebook and their
Northwind work notebook) with the clock fixed at 10:05 on Saturday 2026-10-17 in New York. The
agent gets a two-line system prompt, the server's instructions and the tool descriptions, and
nothing else.

## By hand, without an API key

Any MCP client can be the agent instead: a Claude Code or Claude Desktop conversation, on your
own Claude account. In Claude Code, run `/run-evals` in this repository and it walks you through
it. Underneath:

```sh
npm run eval:manual -- list                  # the scenarios
npm run eval:manual -- setup misheard-name   # fresh notebooks, an mcp.json, the lines to say
cd /tmp/cos-notebook-eval/agent && claude --mcp-config ../mcp.json --strict-mcp-config
npm run eval:manual -- check                 # grade it
```

(The folder is the system temp folder's `cos-notebook-eval`; setup prints it.) Run the agent
from the empty `agent` folder so it sees only the notebook tools, not this repository, and start
a new conversation for each scenario. The eval server logs each tool call's name, refusal code
and result size, never what was said, so `check` can count calls; it counts them per scenario,
not per exchange. These runs use the client's own system prompt and tools, so they measure the
notebook inside a full client, not the bare tool descriptions that `npm run eval` measures.

## What is measured

| Measure | Meaning |
|---|---|
| passed | Every check held, and no budget was exceeded |
| calls/exchange, max calls | Tool calls per turn of the person's; each scenario sets a budget |
| refused | Calls the service refused (close names, ambiguous matches, bad arguments) |
| writes | Successful writes; read-only scenarios have a budget of 0 |
| duplicates | Duplicate items created, plus new people, projects or areas whose name is close to an existing one |
| wrong place | Items filed in the other notebook (personal versus work) |
| tokens read | Tool results the agent read, estimated at four characters a token |
| input, output tokens | What the model calls used, from the API's usage counts |

Full results, with every tool call and the agent's replies, go to `evals/results/` (not
committed).

## Adding a scenario

Add it to `scenarios.ts`: what the person says (one string per exchange), checks on the notebooks
afterwards, a tool-call budget, and `ideal`, the calls a good agent would make. `npm test` replays
every scenario's ideal calls without a model, so a scenario whose checks can't pass, or whose
ideal calls the service refuses, fails in CI. Use invented people and companies only.

Use the results to change tool shapes and descriptions, then run the scenarios again.

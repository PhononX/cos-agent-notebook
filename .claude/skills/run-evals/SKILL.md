---
name: run-evals
description: Run the notebook's agent evaluations by hand, with a separate Claude Code or Claude Desktop conversation as the agent, instead of npm run eval and the API. Use when asked to run the evals by hand, without an API key, or to try one scenario.
---

# Run the agent evaluations by hand

The person plays Alex and talks to a separate agent conversation that has only the notebook's
MCP tools. You set up each scenario, hand them the lines to say, and grade the result. You are
the operator, not the agent: never call the notebook tools yourself.

## Steps

1. List the scenarios with `npm run -s eval:manual -- list`. Ask which to run, or go through all
   of them in order.

2. Set one up: `npm run -s eval:manual -- setup <scenario>`. This resets the eval notebooks (in
   the system temp folder, `cos-notebook-eval`, unless a folder is given after the scenario),
   writes `mcp.json` there, and prints the lines Alex says. Show the person the lines exactly as
   printed.

3. Tell the person how to start the agent, in a new conversation for every scenario:
   - **Claude Code**, in another terminal, from the empty `agent` folder so the agent can't read
     this repository:
     `cd <dir>/agent && claude --mcp-config <dir>/mcp.json --strict-mcp-config`
     (with `<dir>` from the setup output).
   - **Claude Desktop**: add the `notebook` entry from `mcp.json` to its MCP servers once,
     restart it, then start a new chat for each scenario. Setup resets the notebooks under the
     running server, so it doesn't need restarting between scenarios.

   They send each line as its own message and wait for the reply. If the agent asks something,
   they answer briefly as Alex would.

4. Don't tell the person what the checks look for until they've finished the conversation:
   knowing would steer how they talk to the agent.

5. When they say they're done, run `npm run -s eval:manual -- check` and report: PASS or FAIL,
   each failed check with its detail, the tool calls in order (refusals show their error code),
   and the counts. The full result is saved in `evals/results/`.

6. After several scenarios, give a short tally: which passed, total refusals and their codes,
   duplicates and filing mistakes. For each failure, say what in the tool descriptions or tool
   shapes (`src/adapters/mcp/server.ts`, `docs/operations.md`) likely misled the agent, and
   propose a change. Change nothing without asking, and keep `SPEC.md` in step if the design
   changes.

## Notes

- The eval server's clock starts at 10:05 on Saturday 2026-10-17 in New York, so "Tuesday" means
  2026-10-20 whatever today is.
- The agent's own system prompt and other tools differ from the API harness (`npm run eval`),
  which gives the model only a two-line prompt. Say which way results were produced when
  comparing them.
- The call log holds tool names, refusal codes and result sizes only, never what was said.

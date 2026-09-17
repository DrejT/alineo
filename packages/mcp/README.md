# alineo-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP client (Claude Code, Claude
Desktop, Cursor, a scripted client, …) orchestrate swarms of sandboxed coding agents through
[alineod](../../apps/alineod), alineo's HTTP + SSE control daemon, plus manage the local
agent-spec cache.

Stdio transport, launched as a local process by the MCP client — the same shape as most MCP
servers (filesystem, GitHub, …), not a hosted worker like [`@alineo-labs/docs-mcp`](../../apps/docs-mcp).

## Tools

**alineod — swarm control** (requires alineod running, default `http://127.0.0.1:4600`, override
with `ALINEOD_URL`):

| Tool                   | Route                           |                                                         |
| ---------------------- | ------------------------------- | ------------------------------------------------------- |
| `alineod_create_run`   | `POST /runs`                    | Load the root agent from an AgentSpec, start a run      |
| `alineod_get_run`      | `GET /runs/:runId`              | The spawn tree — every agent, state, parent pointers    |
| `alineod_delete_run`   | `DELETE /runs/:runId`           | Abort + close every live agent in the run               |
| `alineod_watch_events` | `GET /runs/:runId/events` (SSE) | Collect lifecycle + harness events for a bounded window |
| `alineod_spawn_agent`  | `POST /runs/:runId/agents`      | Fork a child under a live parent                        |
| `alineod_get_agent`    | `GET /agents/:agentId`          | Inspect an agent + session stats                        |
| `alineod_prompt_agent` | `POST /agents/:agentId/prompt`  | Drive one turn                                          |
| `alineod_steer_agent`  | `POST /agents/:agentId/steer`   | Redirect the current turn                               |
| `alineod_pause_agent`  | `POST /agents/:agentId/pause`   | Freeze the sandbox container                            |
| `alineod_resume_agent` | `POST /agents/:agentId/resume`  | Thaw a paused container                                 |
| `alineod_stop_agent`   | `POST /agents/:agentId/stop`    | Abort + close one agent                                 |
| `alineod_get_result`   | `GET /agents/:agentId/result`   | Resolve a settled agent's output (optional long-poll)   |

**alineo — local bootstrap + spec management** (no alineod required for these):

| Tool                 |                                                              |
| -------------------- | ------------------------------------------------------------ |
| `alineo_init`        | Start OpenSandbox + alineod locally via Docker               |
| `alineo_add_spec`    | Fetch an AgentSpec (URL or local file), validate it, save it |
| `alineo_list_specs`  | List saved agent specs                                       |
| `alineo_remove_spec` | Remove a saved agent spec                                    |

This mirrors every alineod HTTP route and every `alineo-cli` subcommand except `telemetry`
(local opt-in/out toggle, not an orchestration feature) and the CLI's direct-sandbox commands
(`spawn`/`prompt`/`fork`/`agents`/`kill`/`logs`) — those drive a sandbox from _this_ process via
`Alineo.load()`; alineod's routes are the equivalent, network-addressable operations for a
swarm run through the daemon, which is what an MCP client actually talks to.

## Install

Not published to npm yet on this branch — for now, build it locally from the repo:

```bash
git clone https://github.com/DrejT/alineo.git && cd alineo
bun install && bun run --cwd packages/mcp build   # → packages/mcp/dist/index.mjs
```

Once published, `npx -y alineo-mcp` (or `bunx alineo-mcp`) will fetch and run it with no local
checkout needed — the client configs below assume that form; swap in
`bun /absolute/path/to/alineo/packages/mcp/dist/index.mjs` for a local build.

## Configure a client

Every MCP client uses the same JSON shape — an entry under `mcpServers` naming the command to
launch and (optionally) environment variables to set. Where that JSON lives differs per client:

| Client               | Config file                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop       | `claude_desktop_config.json` ([platform paths](https://modelcontextprotocol.io/quickstart/user))                            |
| Claude Code (CLI)    | `~/.claude.json` (user scope) or `.mcp.json` in a project (project scope) — or skip the file and run `claude mcp add` below |
| Cursor               | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a project                                                            |
| Any other MCP client | Its own equivalent `mcpServers` config, or point it at the stdio command directly                                           |

```json
{
  "mcpServers": {
    "alineo": {
      "command": "npx",
      "args": ["-y", "alineo-mcp"],
      "env": {
        "ALINEOD_URL": "http://127.0.0.1:4600"
      }
    }
  }
}
```

`env` is optional — omit it to use the default `http://127.0.0.1:4600`, which is what
`alineo_init` (see below) starts alineod on.

**Claude Code CLI**, no file editing needed:

```bash
claude mcp add alineo -- npx -y alineo-mcp
# scope to just this project instead of every session:
claude mcp add alineo --scope project -- npx -y alineo-mcp
# with a non-default alineod URL:
claude mcp add alineo --env ALINEOD_URL=http://127.0.0.1:4600 -- npx -y alineo-mcp
```

**A local build** (this branch, before publishing), in any of the configs above:

```json
{
  "mcpServers": {
    "alineo": {
      "command": "bun",
      "args": ["D:/path/to/alineo/packages/mcp/dist/index.mjs"],
      "env": { "ALINEOD_URL": "http://127.0.0.1:4600" }
    }
  }
}
```

**Scripted / programmatic client** — connect over stdio from your own code instead of a chat
client; see [`cookbooks/mcp-agent-swarm`](../../cookbooks/mcp-agent-swarm) for a full runnable
recipe using `@modelcontextprotocol/client`'s `StdioClientTransport`.

## Configuration reference

| Setting                | Where                                                                                                                                                      | Default                  | Affects                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| `ALINEOD_URL`          | env var on the `alineo-mcp` process                                                                                                                        | `http://127.0.0.1:4600`  | Every `alineod_*` tool                                           |
| `alineo.config.json`   | project-local file, or `~/.config/alineo/config.json` global fallback (same resolution as `alineo-cli`)                                                    | written by `alineo_init` | `agentsDir` for `alineo_add_spec` / `list_specs` / `remove_spec` |
| Docker                 | must be installed and running                                                                                                                              | —                        | `alineo_init` only                                               |
| Model provider API key | in the _caller's_ shell when running `alineo_init` (forwarded into the alineod container) — see the list in `@alineo-labs/cli-shared`'s `pi-model-keys.ts` | none                     | Whether spawned agents can actually call a model                 |

`alineo.config.json`'s `agentsDir` is shared with `alineo-cli` — specs added via either tool show
up in both, since they resolve the same config file and directory.

## Use

```bash
alineo_init           # once, if alineod isn't already running (needs Docker)
```

Typical flow, as a client would call the tools:

1. `alineo_add_spec` (or `alineo_list_specs` if you've already added one) → get an AgentSpec.
2. `alineod_create_run` with that spec → get back a `runId` + `rootAgentId`.
3. `alineod_spawn_agent` with `parentAgentId: rootAgentId` to fan out children — repeat per
   worker; pass `waitFor` on a later spawn to hold it until earlier agents settle.
4. `alineod_prompt_agent` / `alineod_steer_agent` to drive them; `alineod_pause_agent` /
   `alineod_resume_agent` to freeze/thaw without losing state.
5. `alineod_watch_events` (poll as needed) or `alineod_get_run` to observe progress.
6. `alineod_get_result` (optionally with `waitSeconds` to long-poll) to read each settled
   agent's output.
7. `alineod_stop_agent` per agent and/or `alineod_delete_run` to tear the whole run down.

See [`cookbooks/mcp-agent-swarm`](../../cookbooks/mcp-agent-swarm) for this flow as a complete,
runnable script — a lead agent forks two reviewers, one gets paused/resumed and the other
steered mid-turn, and an editor gathers both results into a report, all driven through these
MCP tools instead of raw HTTP.

## Troubleshooting

| Symptom                                                                                                                 | Cause                                                                                                                                                                                    | Fix                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `alineod_*` call returns `alineod error (network): Could not reach alineod...`                                    | alineod isn't running, or `ALINEOD_URL` points at the wrong address                                                                                                                      | Run `alineo_init` (needs Docker), or check what's actually listening on the configured URL                                                                            |
| `alineod error (404): no run ...` / `no agent ...`                                                                      | Wrong ID, or the run/agent was already deleted/stopped                                                                                                                                   | Re-check the ID from the tool result that created it; `alineod_get_run` lists current agents                                                                          |
| `alineod error (409): agent ... is not live`                                                                            | The agent's sandbox already ended                                                                                                                                                        | Check `alineod_get_agent`'s `state`/`outcome` before prompting again                                                                                                  |
| `alineo_init` fails at "Checking Docker..."                                                                             | Docker isn't installed or the daemon isn't running                                                                                                                                       | Start Docker Desktop (or your Docker daemon) and retry                                                                                                                |
| A spawned agent never produces a result                                                                                 | No model provider key was forwarded to alineod                                                                                                                                           | Set the relevant key (e.g. `NVIDIA_API_KEY`) in the shell _before_ running `alineo_init`, or add it to the running alineod container's env directly                   |
| Raw `@alineo-labs/sandbox` SDK code on the host can't follow a sandbox's proxy URL, even though `alineo_init` succeeded | Windows/Mac: alineod reaches OpenSandbox via `host.docker.internal`, which the host itself can't reliably resolve back to itself — see `packages/cli/src/commands/init.ts`'s doc comment | Use `alineod_*` tools instead of the raw SDK against this same OpenSandbox instance, or run OpenSandbox via `uvx opensandbox-server` for direct host-based SDK access |

## Local development

```bash
bun install
bun run dev          # bun run src/index.ts, stdio server on this process's stdin/stdout
bun run typecheck
bun run test
bun run build         # tsdown → dist/index.mjs
```

`src/server.ts` builds the `McpServer` independently of the stdio transport (`src/index.ts`), so
tests connect it to an in-memory client over `InMemoryTransport` instead of spawning a process —
see `test/server.test.ts`.

## Design notes

- **stdio, not HTTP.** An MCP client launches this as a subprocess; `stdout` is the JSON-RPC
  channel, so nothing in this package may `console.log` — diagnostics go to `console.error`.
- **Thin HTTP client, not the `alineo` SDK.** `src/alineod-client.ts` talks to alineod purely
  over its documented wire contract (`apps/alineod/src/schema.ts`,
  `specs/alineod/openapi.json`), the same way any external MCP client would — alineod is
  "standalone by design" (its own README), and this package doesn't reach into its internals.
- **Every tool handler is error-safe.** A thrown error (alineod unreachable, a 404, invalid
  input) becomes an `isError` tool result, never an uncaught rejection that could take the
  server down mid-session.
- **`alineod_watch_events` is poll-and-collect, not a live stream.** An MCP tool call is
  request/response; the tool collects SSE events for a bounded window (default 20s, capped at
  120s) and returns them, honoring `Last-Event-ID` via `sinceEventId` so repeated calls don't
  miss anything persisted.

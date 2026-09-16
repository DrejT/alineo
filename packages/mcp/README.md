# alineo-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP client (Claude Code, Claude
Desktop, Cursor, …) orchestrate swarms of sandboxed coding agents through
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

## Use

```bash
alineo_init           # once, if alineod isn't already running (needs Docker)
```

Point an MCP client at `alineo-mcp` (stdio):

```json
{
  "mcpServers": {
    "alineo": {
      "command": "npx",
      "args": ["-y", "alineo-mcp"]
    }
  }
}
```

Typical flow: `alineo_add_spec` (or `alineo_list_specs`) to get an AgentSpec →
`alineod_create_run` → `alineod_spawn_agent` to fan out children →
`alineod_prompt_agent` / `alineod_steer_agent` to drive them → `alineod_watch_events` or
`alineod_get_run` to observe progress → `alineod_get_result` → `alineod_stop_agent` /
`alineod_delete_run` to tear down.

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

# mcp-agent-swarm

The same code review swarm as [`../swarm-code-review`](../swarm-code-review), driven entirely
through [`alineo-mcp`](../../packages/mcp)'s tools instead of raw `alineod` HTTP calls — the MCP
client counterpart, useful for comparing `index.ts` in each recipe side by side line for line.

```
review-lead ── clones expressjs/cors once
  ├── reviewer: security      ┐
  └── reviewer: correctness   ┘─ forked from the lead's sandbox — the checkout is already there
  editor ── waits for both, merges their findings into one report
```

Every step below is an `alineo-mcp` tool call — `alineod_create_run`, `alineod_spawn_agent`,
`alineod_pause_agent` / `resume_agent`, `alineod_steer_agent`, `alineod_watch_events`,
`alineod_get_result`, `alineod_get_run`, `alineod_delete_run` — the same tools a chat client
(Claude Code, Claude Desktop, Cursor) would call if you asked it to run this review for you once
`alineo-mcp` is in its `mcpServers` config (see [`packages/mcp/README.md`](../../packages/mcp/README.md)).
This recipe is that same client, scripted, via `mcp-client.ts`'s tiny wrapper around
[`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client).

## Setup

```bash
bunx alineo-cli init              # starts OpenSandbox in Docker (one-time setup)
bun install                       # from the repo root
bun run --cwd packages/mcp build  # builds packages/mcp/dist/index.mjs, which this recipe spawns
```

Start alineod in its own terminal, with an NVIDIA key ([build.nvidia.com](https://build.nvidia.com),
free tier available) in **its** environment:

```bash
cd apps/alineod
NVIDIA_API_KEY=nvapi-... bun run start
```

## Run

```bash
cd cookbooks/mcp-agent-swarm
bun install
bun start
```

Set `ALINEOD_URL` if the daemon isn't on `http://localhost:4600` — `mcp-client.ts` passes it
through to `alineo-mcp` as the env var the server itself reads.

## What it does

1. **Connects to `alineo-mcp` over stdio** (`mcp-client.ts`), the same transport a chat client
   uses — `Bun.spawn`-launched, JSON-RPC over stdin/stdout.
2. **Checks out the repository once**, via `alineod_create_run` with `agents/lead.json` (which
   installs `git` and clones `expressjs/cors` as a setup step) and an initial prompt. The lead's
   first turn reports the commit being reviewed (`alineod_get_result`).
3. **Forks a reviewer per concern** — security and correctness — with `alineod_spawn_agent`. Each
   is a fork of the lead's live sandbox, so the checkout is already on disk; nothing is cloned
   twice. Each spawn carries an `idempotencyKey`, so a retried call can't create a duplicate
   reviewer. The lead's `spawnDepth: 1` and `maxAgents: 4` cap how far the swarm can grow.
4. **Intervenes mid-review** with three more tools: `alineod_pause_agent` / `alineod_resume_agent`
   freeze and thaw the correctness reviewer's container for five seconds without restarting it;
   `alineod_steer_agent` narrows the security reviewer's brief mid-turn.
5. **Gathers** with one more `alineod_spawn_agent` call for the editor, carrying `waitFor` on
   both reviewers — alineod holds it until they finish, then writes each reviewer's findings into
   its sandbox under `/inputs/`, with an `/inputs.json` manifest including each outcome.
6. **Reports.** The merged report comes back from `alineod_get_result` and is printed and written
   to `review.md`, followed by the final agent tree from `alineod_get_run`. `alineod_delete_run`
   then closes every sandbox.

Progress for every agent streams via repeated `alineod_watch_events` calls, each a bounded
5-second window resuming from the last event id seen (`sinceEventId`) — since an MCP tool call is
request/response, this is a poll-and-collect loop rather than one held-open SSE connection (which
is what `../swarm-code-review`'s raw-HTTP version uses instead — compare `watch()` in each).

To review a different repository, change the clone URL in `agents/lead.json` and the paths and
concerns in `index.ts`, same as `../swarm-code-review`.

See [`packages/mcp/README.md`](../../packages/mcp/README.md) for the full tool reference and
client configuration (Claude Code, Claude Desktop, Cursor), and the
[alineod docs](https://docs.alineo.tech/docs/alineod) for every underlying HTTP route and event.

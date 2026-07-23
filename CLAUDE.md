# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> For any questions about the OpenSandbox API, behavior, or internals, use the DeepWiki MCP tool (`mcp__deepwiki__ask_question`) against `https://deepwiki.com/opensandbox-group/OpenSandbox/`.
>
> For any questions about the Pi coding agent CLI, RPC protocol, session management, or available commands, use the DeepWiki MCP tool against `https://deepwiki.com/earendil-works/pi/`.
>
> For any questions about the GitHub CLI (`gh`), its commands, or API usage, use the DeepWiki MCP tool against `https://deepwiki.com/cli/cli`.

## Agent Skills

Reusable skill references live in `.agents/skills/<name>/SKILL.md`. Always check this folder before reaching for external docs — skills contain curated quick references and gotchas specific to tools used in this repo.

Available skills:

- **`.agents/skills/bun/`** — Bun runtime, package manager, test runner, and bundler. Covers `bun run`, `bun install`, `bun test`, `bun build`, workspace flags, common gotchas (flag placement, lifecycle scripts, lockfile format), and key APIs (`Bun.file()`, `Bun.serve()`, `Bun.write()`)

Example: before writing a `bun build` command or debugging a workspace install issue, read `.agents/skills/bun/SKILL.md` for the correct flags and known pitfalls.

## What this is

`drej` is a **sandbox execution substrate** built on top of [OpenSandbox](https://opensandbox.ai). It gives you live sandbox containers as first-class objects — spawn, exec, checkpoint, resume — with a durable SQL audit ledger and replay. Workflow primitives (retry, when, forEach, parallel) live in the separate `@drej/workflow` package.

## Commands

```bash
# Run an example (requires OpenSandbox server — use drejx init or uvx opensandbox-server)
bun examples/hello-world/index.ts

# Run all unit tests
bun run test

# Build the SDK for publishing (generates dist/ across all packages)
bun run build

# Typecheck all packages
bun run typecheck

# `test`/`build`/`typecheck` are driven by scripts/workspace-run.ts, which auto-discovers
# every package under the root package.json's "workspaces" array (topologically sorted by
# "workspace:*" dependency edges) — a new package is picked up the moment it's added there
# and has the relevant tsconfig.json/package.json script, with no second place to register
# it. To typecheck one package in isolation while iterating:
bunx tsc --noEmit --strict --project packages/<name>/tsconfig.json

# Changesets (required on every PR touching publishable packages)
bunx changeset        # add a changeset
bunx changeset status # verify one exists

# IMPORTANT: after committing code changes, always add and commit a changeset too.
# The CI changeset check (bunx changeset status --since origin/main) reads from
# git history — an uncommitted changeset file will NOT satisfy it.
```

## Testing

### Two test layers

**Unit tests** live in `packages/*/test/*.test.ts` and run via `bun test`. They test internal builder logic, control-flow, and adapter behaviour in isolation — no sandbox required.

**Integration tests** live in `tests/integration/<name>.test.ts` (one `@drej/integration-tests` workspace, not co-located with each example) and run via `bun run test:integration` from the repo root, or `cd tests/integration && bun test <name>.test.ts` for one file. They use `bun:test`'s `test()`/`expect()` against a real OpenSandbox sandbox — largely mirroring what the matching `examples/<name>/index.ts` demonstrates, but with real assertions instead of `console.log`. Most (not all) examples have one; `scripts/new-example.ts` scaffolds a stub alongside a new example.

`examples/<name>/index.ts` itself is also directly runnable (`bun examples/<name>/index.ts`) as a human-readable demo — the two are complementary, not duplicates: the example is what a user reads/copies, the test is what CI would assert on.

### Integration test conventions

- **Run with**: `bun run test:integration` from the repo root, or `cd tests/integration && bun test` for the whole suite / `bun test <name>.test.ts` for one file.
- **Requires**: OpenSandbox server running locally — either `drejx init` (Docker-based, recommended) or `uvx opensandbox-server` (manual). If using `drejx init`, pass `useServerProxy: true` to `new Drej(...)` so the SDK routes through the server instead of container-direct IPs.
- **Client setup**: `new Drej({ baseUrl: ..., adapter: new SQLiteAdapter(":memory:") })` — no `connect()` or `close()` needed on the client itself.
- **Sandbox lifecycle**: always wrap in `try/finally { await sb.close(); }` to avoid container leaks.
- **Assertion**: `const { stdout, exitCode } = await sb.exec("cmd")` — assert on the returned value. For error cases, catch `CommandError`.

### What to assert

Assert on observable behaviour, not internal structure:
- `await sb.exec("cmd")` result: `stdout`, `stderr`, `exitCode`
- `await sb.readFile("/path")` content
- error class and `.exitCode` for `CommandError` cases

## Architecture

```
packages/core/                    — Sandbox primitive (no runtime deps outside opensandbox)
  src/sandbox/core.ts             — SandboxCore: private state, exec()/execCode()/createCodeContext()/createSession()
  src/sandbox/sandbox.ts          — Sandbox class (extends SandboxCore): file/lifecycle/observability delegators
  src/sandbox/files.ts            — writeFile/readFile/deleteFile/moveFile/listDirectory/searchFiles/...
  src/sandbox/lifecycle.ts        — pause/resume/checkpoint/fork/close/listCheckpoints
  src/sandbox/observability.ts    — metrics/watchMetrics/diagnosticLogs/diagnosticEvents/proxy
  src/sandbox/bash-session.ts     — BashSession class
  src/sandbox/resolve.ts          — resolveExecClient()
  src/sandbox/types.ts            — ExecOptions, SandboxHooks, SandboxDeps, PendingInteractiveExec, ExecCodeOptions
  src/sandbox/internal.ts         — SandboxInternal (package-private facade the split modules operate over)
  src/sandbox/index.ts            — barrel — re-exported from src/index.ts
  src/exec-handle.ts              — ExecHandle (PromiseLike<ExecResult>), pipe(), stdout(), result()
  src/ledger.ts                   — IStorageAdapter, LedgerEvent, SandboxStatus, SandboxDetails, ListSandboxOptions
  src/errors.ts                   — WorkflowError, SandboxError, ExecConnectionError, CommandError
  src/logger.ts                   — ILogger, ConsoleLogger, noopLogger

packages/opensandbox/             — OpenSandbox HTTP clients
  src/control.ts                  — ControlClient (sandbox lifecycle via REST)
  src/exec.ts                     — ExecClient (code/command execution via SSE)
  src/types.ts                    — Full OpenSandbox API type system

packages/sdks/typescript/         — Public TypeScript SDK (published to npm as "drej")
  src/types.ts                    — DrejError, DrejOptions, SandboxOptions
  src/client.ts                   — Drej: sandbox(), resume(), sandboxes.*

packages/workflow/                — Lazy workflow builder (published as "@drej/workflow")
  src/sandbox-builder.ts          — SandboxBuilder (synchronous queue), flushOps()
  src/workflow-builder.ts         — WorkflowBuilder, workflow() factory
  src/index.ts                    — barrel exports

packages/adapters/postgres/       — Postgres storage adapter (published as "@drej/postgres")
  src/adapter.ts                  — PostgresAdapter implementing IStorageAdapter
  src/migrations.ts               — Idempotent CREATE TABLE IF NOT EXISTS schema

packages/adapters/sqlite/         — SQLite storage adapter (published as "@drej/sqlite")
  src/adapter.ts                  — SQLiteAdapter via bun:sqlite (zero extra deps, WAL mode enabled)
  src/migrations.ts               — Idempotent CREATE TABLE IF NOT EXISTS schema

packages/adapters/otel/           — OpenTelemetry hooks adapter (published as "@drej/otel")
  src/index.ts                    — otelHooks(tracer, opts?) → SandboxHooks

packages/adapters/flue/           — Flue runtime adapter (published as "@drej/flue")
  src/index.ts                    — SandboxApi/SandboxFactory implementation backing @flue/runtime with a drej Sandbox

packages/agent/                   — Agent SDK (published to npm as "@drej/agent")
  src/agent/factory.ts            — load()/resume()/attach()/spawn() bodies (snapshot restore, env resolution,
                                    spawn-depth/max-agents enforcement) — returns constructor args, not an Agent
                                    directly, since only Agent's own static methods may call its private constructor
  src/agent/agent.ts               — Agent class: constructor + every public method as a 1-line delegator to the
                                    modules below
  src/agent/session-control.ts     — prompt/bash/steer/abort/followUp/newSession/setSteeringMode/...
  src/agent/model.ts                — setModel/cycleModel/getAvailableModels/setThinkingLevel/cycleThinkingLevel
  src/agent/introspection.ts        — getState/getMessages/getSessionStats/getForkMessages/getCommands/getLogs
  src/agent/lifecycle.ts            — fork/clone/switchSession/exportHtml/compact/setEnv/close
  src/agent/validation.ts           — assertValidSpawnDepth/assertValidMaxAgents/resolveParent{SpawnDepth,MaxAgents}
  src/agent/internal.ts             — AgentInternal (package-private facade the split modules operate over)
  src/agent/index.ts                — barrel — re-exported from src/index.ts
  src/adapters/pi.ts                — PiAdapter: install(), configure(), startBridge(), waitReady(); bridges all
                                      Pi RPC commands over HTTP/SSE; emits AgentEvent
  src/adapters/pi-bridge.js         — the actual Node.js CJS HTTP→RPC bridge script, written into the sandbox at
                                      /drej-bridge.js — a real, lint/format-checked file, read by pi.ts relative to
                                      its own module location and copied into dist/ by tsdown's `copy` config
  src/schema.ts                    — AgentSpec interface + SetupStep interface + validateAgentSpec()
  src/snapshots.ts                 — AgentSnapshotStore, computeSetupHash() (hashes cli+cliVersion+packages+setup)
  src/config.ts                    — DrejAgentConfig, readProjectConfig() (reads drej.config.json)
  src/types.ts                     — AgentEvent (text|tool_start|tool_update|tool_end), AgentStream, textOnly(),
                                      PromptStream (deprecated alias), PiModel, ThinkingLevel, PiMessage, CompactResult
  src/index.ts                     — barrel exports

packages/cli/                     — drejx CLI (published to npm as "drejx", not part of changeset versioning)
  src/index.ts                    — CLI entry point (shebang, TTY→TUI launch, dispatch via commands/registry.ts)
  src/commands/registry.ts        — CliCommand metadata (name/group/usage/summary) for every subcommand, each with
                                    a run() that dynamically imports its own implementation on demand — both the
                                    dispatch table and the generated help text are driven off this one list
  src/commands/types.ts           — CliCommand, CommandVariant interfaces
  src/commands/args.ts            — flag() argv helper shared by every command file
  src/commands/init.ts            — drejx init: starts OpenSandbox in Docker, writes drej.config.json
  src/commands/add.ts             — drejx add <url>: fetches an agent spec, saves it locally
  src/commands/list.ts            — drejx list: lists saved agent specs
  src/commands/remove.ts          — drejx remove <name>: deletes a saved agent spec
  src/commands/spawn.ts           — drejx spawn <spec>: Agent.load() a fresh, independent agent sandbox
  src/commands/prompt.ts          — drejx prompt <sandbox-id> <msg>: Agent.resume() + send one prompt
  src/commands/fork.ts            — drejx fork <name> <child-spec>: Agent.attach() + spawn() a child from a live sandbox
  src/commands/agents.ts          — drejx agents: lists running sessions (ledger cross-checked against the live
                                    OpenSandbox control plane, not trusted alone — see sessions-data.ts)
  src/commands/kill.ts            — drejx kill <sandbox-id>: closes a sandbox by ID
  src/commands/logs.ts            — drejx logs <name>: prints ledger events for a session
  src/schema.ts                   — RegistryItem interface + validateRegistryItem()
  src/config.ts                   — DrejxConfig, readConfig(), writeConfig(), serverConfigContent()
  src/sessions-data.ts            — getSessions(): ledger "Running" entries cross-checked against a live
                                    ControlClient query; formatAge()
  src/docker.ts                   — checkDocker(), getContainerState(), startContainer(), runContainer(), pollHealth()
  pi-extension/drejx.ts           — the Pi extension that bootstraps drejx and injects spawn/fork CLI guidance into
                                    a Pi session's system prompt — see plans/pi-extension-rlm-flow.md
```

### Key design points

**Sandbox as first-class object**: `client.sandbox()` returns a live `Sandbox` object. You hold it, call methods on it, and call `sb.close()` when done. Multiple sandboxes → multiple variables. No special API.

**ExecHandle**: `sb.exec("cmd")` returns an `ExecHandle` — a `PromiseLike<ExecResult>` with `pipe()`, `stdout()`, and `result()`. `await sb.exec("cmd")` gives `{ stdout, stderr, exitCode }`. Streaming: `await sb.exec("cmd").pipe(process.stdout)`.

**Durable ledger**: Every exec is logged to the adapter as `exec_start` → `exec_event`s → `exec_complete`. `sb.checkpoint()` snapshots the container and writes `checkpoint_created`. On `client.resume(sandboxId)`: restores from the last snapshot, returns cached results for execs completed before the checkpoint, runs the rest live. Invisible to the user.

**Lazy workflow layer**: `@drej/workflow` provides `workflow(client).sandbox(opts, fn).pipe(sink)`. The `fn` callback receives a `SandboxBuilder` — all methods queue ops synchronously. The queue is flushed when `.pipe()` or `.result()` is awaited. One `await` at the end regardless of workflow complexity.

**Storage adapter**: `DrejOptions.adapter` accepts any `IStorageAdapter`. Pass `new SQLiteAdapter("./drej.db")` for local dev or `new PostgresAdapter(connectionString)` for production. The adapter is initialised lazily on first use — no `connect()` call needed. On process exit, `beforeExit` closes the adapter automatically; explicit teardown is not required for scripts.

**Concurrency limits**: `DrejOptions.maxConcurrency` caps simultaneous active sandboxes. `client.sandbox()` awaits a semaphore slot; the slot is released when `sb.close()` is called.

**Hooks**: `SandboxHooks` provides lifecycle callbacks: `onSandboxCreated`, `onExecStart`, `onExecComplete`, `onCheckpoint`, `onSandboxClosed`, `onSandboxFailed`. Pass via `SandboxOptions.hooks`. Use `otelHooks(tracer)` from `@drej/otel` for OpenTelemetry tracing.

**execd readiness**: OpenSandbox reports a sandbox as "Running" before execd is ready. `resolveExecClient()` calls `getEndpoint()` once (each call returns a different ephemeral proxy port) then polls `listContexts()` until execd responds.

**Sandbox entrypoint**: Always `["tail", "-f", "/dev/null"]` — `/bin/bash` exits immediately without a TTY, killing the container. `client.sandbox()` sets this automatically.

**Resource limits required**: `SandboxOptions.resources` (`{ cpu: string; memory: string; gpu?: string }`) is required — the OpenSandbox server rejects requests without it. Always pass at least `{ cpu: "500m", memory: "256Mi" }`. This applies to `client.sandbox()`, `workflow().sandbox()`, and every step in `workflow().sequence()`.

**Server proxy mode**: When OpenSandbox runs in Docker (via `drejx init`), sandbox containers are on a bridge network and their IPs are unreachable from the host. Set `useServerProxy: true` in `DrejOptions` to route execd and proxy traffic through the server (`?use_server_proxy=true` on `getEndpoint`). The server then returns `{eip}/sandboxes/{id}/proxy/{port}` URLs that are reachable from the host. The server config must have `eip = "http://localhost:8080"` set — `drejx init` writes this automatically.

## Environment variables

`Drej` is configured via constructor options, not environment variables. The consuming application is responsible for reading env vars and passing them in:

| Option | Description |
|---|---|
| `baseUrl` | OpenSandbox server URL (e.g. `http://localhost:8080`) |
| `apiKey` | OpenSandbox API key (empty string for local dev) |
| `adapter` | `IStorageAdapter` implementation (SQLiteAdapter or PostgresAdapter) |
| `maxConcurrency` | Max simultaneous workflow runs (default: unlimited) |
| `useServerProxy` | Route execd/proxy traffic through the server — required when server runs in Docker via `drejx init` (default: `false`) |

## Local OpenSandbox setup

### Option 1 — drejx init (recommended)

`bunx drejx init` starts OpenSandbox in a Docker container (`opensandbox/server:latest`) and writes `~/.config/drejx/server.toml` and `.drej/config.json` automatically. This is the preferred path for users running the full drejx workflow.

When using a server started this way, pass `useServerProxy: true` to `new Drej(...)` — direct container IPs are not reachable from the host over Docker's bridge network.

OpenSandbox's snapshot-metadata db is bind-mounted from `~/.config/drejx/opensandbox-data` into the container (see `serverDataDir()` in `packages/cli/src/config.ts`), so `Agent.load()`'s cached-snapshot fast path survives the container being fully removed and recreated, not just stopped/started — fixes the silent full-rebuild-on-every-restart issue tracked as #20.

### Option 2 — uvx (manual)

Run `uvx opensandbox-server` with `~/.sandbox.toml`:

```toml
[server]
host = "127.0.0.1"
port = 8080

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.19"

[docker]
network_mode = "bridge"

[ingress]
mode = "direct"

[egress]
mode = "dns"
```

The `uvx` path does not need `useServerProxy` — the server is on the host, so direct container IPs are reachable.

## SDK focus

We are currently focused exclusively on making the **TypeScript SDK** (`packages/sdks/typescript`) full-featured and production-ready. Python SDK is maintained but not the priority. Do not add new features to the Python SDK unless explicitly asked.

## Releases

The TypeScript SDK (`packages/sdks/typescript`) is published to npm via changesets. Every PR that changes publishable packages needs a changeset (`bunx changeset`). CI enforces this. Releases are cut automatically via `changesets/action` on merge to `main`.

> **Changeset must be committed** before CI will pass — `bunx changeset status --since origin/main` reads from git history, not disk.

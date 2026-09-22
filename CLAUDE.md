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
- **`.agents/skills/alineo/`** — the `alineo` agent SDK (load/resume/attach/spawn, prompt/bash streaming, session control) and the `alineo-cli`: agent lifecycle, storage adapters, and Windows-specific gotchas.

Example: before writing a `bun build` command or debugging a workspace install issue, read `.agents/skills/bun/SKILL.md` for the correct flags and known pitfalls.

External agents install either skill with the [Skills CLI](https://skills.sh): `npx skills add DrejT/alineo --skill <name>`.

## What this is

`alineo` is an AI agent platform built on sandboxed execution. `@alineo-labs/sandbox` is the
**sandbox execution substrate** built on top of [OpenSandbox](https://opensandbox.ai) — it gives
you live sandbox containers as first-class objects (spawn, exec, checkpoint, resume) with a
durable SQL audit ledger and replay. `alineo` (the bare package name) is the agent SDK built on
top of it — it runs Pi coding agents inside those sandboxes. Workflow primitives (retry, when,
forEach, parallel) live in the separate `@alineo-labs/workflow` package.

## Commands

```bash
# Run an example (requires OpenSandbox server — use alineo init or uvx opensandbox-server)
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

**Integration tests** live in `tests/integration/<name>.test.ts` (one `@alineo-labs/integration-tests` workspace, not co-located with each example) and run via `bun run test:integration` from the repo root, or `cd tests/integration && bun test <name>.test.ts` for one file. They use `bun:test`'s `test()`/`expect()` against a real OpenSandbox sandbox — largely mirroring what the matching `examples/<name>/index.ts` demonstrates, but with real assertions instead of `console.log`. Most (not all) examples have one; `scripts/new-example.ts` scaffolds a stub alongside a new example.

`examples/<name>/index.ts` itself is also directly runnable (`bun examples/<name>/index.ts`) as a human-readable demo — the two are complementary, not duplicates: the example is what a user reads/copies, the test is what CI would assert on.

### Integration test conventions

- **Run with**: `bun run test:integration` from the repo root, or `cd tests/integration && bun test` for the whole suite / `bun test <name>.test.ts` for one file.
- **Requires**: OpenSandbox server running locally — either `alineo init` (Docker-based, recommended) or `uvx opensandbox-server` (manual). If using `alineo init`, pass `useServerProxy: true` to `new Sandbox(...)` so the SDK routes through the server instead of container-direct IPs.
- **Client setup**: `new Sandbox({ baseUrl: ..., adapter: new SQLiteAdapter(":memory:") })` — no `connect()` or `close()` needed on the client itself.
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
  src/sandbox/sandbox.ts          — SandboxHandle class (extends SandboxCore): file/lifecycle/observability delegators
  src/sandbox/files.ts            — writeFile/readFile/deleteFile/moveFile/listDirectory/searchFiles/...
  src/sandbox/lifecycle.ts        — pause/resume/checkpoint/fork/close/listCheckpoints
  src/sandbox/observability.ts    — metrics/watchMetrics/diagnosticLogs/diagnosticEvents/proxy
  src/sandbox/hooks.ts            — composeHooks(): merges multiple SandboxHooks into one, each hook invocation
                                    isolated in its own try/catch so one broken adapter can't break siblings or
                                    the sandbox operation that triggered them
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

packages/sdks/typescript/         — Sandbox client SDK (published to npm as "@alineo-labs/sandbox")
  src/types.ts                    — SandboxClientError, SandboxClientOptions, SandboxOptions
  src/client.ts                   — Sandbox: sandbox(), resume(), sandboxes.*

packages/workflow/                — Lazy workflow builder (published as "@alineo-labs/workflow")
  src/sandbox-builder.ts          — SandboxBuilder (synchronous queue), flushOps()
  src/workflow-builder.ts         — WorkflowBuilder, workflow() factory
  src/index.ts                    — barrel exports

packages/adapters/postgres/       — Postgres storage adapter (published as "@alineo-labs/postgres")
  src/adapter.ts                  — PostgresAdapter implementing IStorageAdapter
  src/migrations.ts               — Idempotent CREATE TABLE IF NOT EXISTS schema

packages/adapters/sqlite/         — SQLite storage adapter (published as "@alineo-labs/sqlite")
  src/adapter.ts                  — SQLiteAdapter via bun:sqlite (zero extra deps, WAL mode enabled)
  src/migrations.ts               — Idempotent CREATE TABLE IF NOT EXISTS schema

packages/adapters/otel/           — OpenTelemetry hooks adapter (published as "@alineo-labs/otel")
  src/index.ts                    — otelHooks(tracer, opts?) → SandboxHooks

packages/adapters/flue/           — Flue runtime adapter (published as "@alineo-labs/flue")
  src/index.ts                    — SandboxApi/SandboxFactory implementation backing @flue/runtime with a SandboxHandle

packages/agent/                   — Alineo SDK (published to npm as "alineo")
  src/agent/factory.ts            — load()/resume()/attach()/spawn() bodies (snapshot restore, env resolution,
                                    spawn-depth/max-agents enforcement) — returns constructor args, not an Alineo
                                    directly, since only Alineo's own static methods may call its private constructor
  src/agent/agent.ts               — Alineo class: constructor + every public method as a 1-line delegator to the
                                    modules below
  src/agent/session-control.ts     — prompt/bash/steer/abort/followUp/newSession/setSteeringMode/...
  src/agent/model.ts                — setModel/cycleModel/getAvailableModels/setThinkingLevel/cycleThinkingLevel
  src/agent/introspection.ts        — getState/getMessages/getSessionStats/getBranchPoints/getCommands/getLogs
  src/agent/lifecycle.ts            — fork/clone/switchSession/exportHtml/compact/setEnv/close
  src/agent/validation.ts           — assertValidSpawnDepth/assertValidMaxAgents/resolveParent{SpawnDepth,MaxAgents}
  src/agent/internal.ts             — AgentInternal (package-private facade the split modules operate over)
  src/agent/index.ts                — barrel — re-exported from src/index.ts
  src/adapters/pi.ts                — PiAdapter: install(), configure(), startBridge(), waitReady(); bridges all
                                      Pi RPC commands over HTTP/SSE; emits AgentEvent
  src/adapters/pi-bridge.js         — the actual Node.js CJS HTTP→RPC bridge script, written into the sandbox at
                                      /alineo-bridge.js — a real, lint/format-checked file, read by pi.ts relative to
                                      its own module location and copied into dist/ by tsdown's `copy` config
  src/schema.ts                    — AgentSpec interface + SetupStep interface + validateAgentSpec()
  src/snapshots.ts                 — AgentSnapshotStore, computeSetupHash() (hashes harness+harnessVersion+packages+setup)
  src/config.ts                    — AlineoAgentConfig, readProjectConfig() (reads alineo.config.json)
  src/types.ts                     — AgentEvent (text|tool_start|tool_update|tool_end), AgentStream, textOnly(),
                                      PromptStream (deprecated alias), PiModel, ThinkingLevel, PiMessage, CompactResult
  src/index.ts                     — barrel exports

packages/cli-shared/               — internal only, never published (alineo-cli only publishes its bin — see
                                    below); Docker orchestration, project/server config, and the `alineo init` /
                                    `init` bootstrap logic shared by alineo-cli and alineo-mcp. Consumed as a
                                    workspace:* devDependency and bundled into each consumer's own dist at build
                                    time, not resolved at the published package's runtime.
  src/config.ts                   — AlineoConfig, readConfig(), writeConfig(), serverConfigContent()
  src/docker.ts                   — checkDocker(), getContainerState(), startContainer(), runContainer(), pollHealth(),
                                    isReachable()
  src/pi-model-keys.ts             — PI_MODEL_API_KEY_ENV_VARS forwarded into the alineod container on init
  src/init.ts                     — runInit(log): the actual `alineo init` / `init` orchestration, logging
                                    through an injectable callback so alineo-cli (console.log) and alineo-mcp (a
                                    collected log array — its stdout is the JSON-RPC channel) can share it verbatim

packages/cli/                     — alineo CLI (published to npm as "alineo-cli", changeset-tracked like every other package)
  src/index.ts                    — CLI entry point (shebang, TTY→TUI launch, dispatch via commands/registry.ts)
  src/commands/registry.ts        — CliCommand metadata (name/group/usage/summary) for every subcommand, each with
                                    a run() that dynamically imports its own implementation on demand — both the
                                    dispatch table and the generated help text are driven off this one list
  src/commands/types.ts           — CliCommand, CommandVariant interfaces
  src/commands/args.ts            — flag() argv helper shared by every command file
  src/commands/init.ts            — alineo init: thin wrapper around @alineo-labs/cli-shared's runInit()
  src/commands/add.ts             — alineo add <url>: fetches an agent spec, saves it locally
  src/commands/list.ts            — alineo list: lists saved agent specs
  src/commands/remove.ts          — alineo remove <name>: deletes a saved agent spec
  src/commands/start.ts           — alineo start <spec>: Alineo.start() a fresh, independent agent sandbox
  src/commands/prompt.ts          — alineo prompt <sandbox-id> <msg>: Alineo.resume() + send one prompt
  src/commands/spawn.ts           — alineo spawn <parent> <child-spec>: Alineo.attach() + spawn() a child from a live sandbox
  src/commands/agents.ts          — alineo agents: lists running sessions (ledger cross-checked against the live
                                    OpenSandbox control plane, not trusted alone — see sessions-data.ts)
  src/commands/stop.ts            — alineo stop <sandbox-id>: closes a sandbox by ID
  src/commands/logs.ts            — alineo logs <name>: prints ledger events for a session
  src/schema.ts                   — RegistryItem interface + validateRegistryItem()
  src/sessions-data.ts            — getSessions(): ledger "Running" entries cross-checked against a live
                                    ControlClient query; formatAge()
  pi-extension/alineo.ts          — the Pi extension that bootstraps alineo and injects start/spawn CLI guidance
                                    into a Pi session's system prompt — see plans/pi-extension-rlm-flow.md

packages/schema/                  — the shapes of the system (published as "@alineo-labs/schema")
  src/vocabulary.ts               — SUBJECTS / VERBS: the words every surface derives its names from
  src/envelope.ts                 — LedgerEnvelope: one record shape for an event from any layer
  src/define.ts                   — defineEvent() + the registry allEvents()/getEvent()/durableEvents() read
  src/events/*.ts                 — one file per layer: sandbox, agent, harness, workflow, alineod
  src/agent-spec.ts               — AgentSpec (interface AND Zod, kept in step by a type-level drift test)
  src/permissions.ts              — permission-policy shapes; the behaviour stays in packages/agent
  src/renames.ts                  — old flat event name → new namespaced one. Dated and deletable: it exists
                                    for the one-time store migrations, not as a permanent alias table
  Types and Zod only, no behaviour. Two entry points: "@alineo-labs/schema/types" has no Zod in its
  graph, so a package with no validator dependency can take a shape and have it erase at compile time.

packages/ledger/                  — behaviour for the ledger (published as "@alineo-labs/ledger")
  src/sink.ts                     — EventSink, composeSinks(), memorySink(), jsonlSink(). A sink is
                                    synchronous and must not throw: it runs on the write path of a sandbox
                                    operation, so an async one becomes backpressure and a throwing one
                                    fails the very operation being recorded
  src/storage.ts                  — LedgerStorage (three methods, not fourteen) + MemoryStorage
  src/fold.ts                     — replay helpers for the fold-equivalence gate
  src/rename-events.ts            — the one-time event-name UPDATE both storage adapters run, here because
                                    both need it and neither should depend on the other

packages/logger/                  — silent-by-default logger (published as "@alineo-labs/logger")
  Libraries call getLogger(component) and never console.*; apps call installLoggerFromEnv().
  Enforced by no-console in .oxlintrc.json.

packages/config-shared/           — internal only: where every setting comes from, merged and frozen once
packages/instructions/            — internal only: builds a structured system prompt out of named sections
packages/memory/                  — episodic + semantic memory (published as "@alineo-labs/memory")
packages/model-providers/         — provider/model catalogue lookups
packages/agent-browser/           — browser streaming relay for an agent's sandbox
packages/mcp/                     — alineo-mcp: MCP server over alineod's HTTP+SSE API. Tools are
                                    {subject}_{verb} (run_start, agent_spawn, spec_add), checked in CI

apps/alineod/                     — the swarm control daemon: HTTP + SSE, Bun + Elysia + bun:sqlite
  src/engine/emit.ts              — THE single write path: append row → fold projection → publish to the
                                    bus → hand a LedgerEnvelope to the sinks. Every state change goes
                                    through here, which is why changes to it stay strictly additive
  src/state/db.ts                 — three tables; `ledger` is the source of truth, `agents`/`handles` are
                                    caches rebuildable from it (crash-only design)
  src/state/projection.ts         — apply()/rebuild(): the only writer of the cache tables
  src/schema.ts                   — the wire contract as Zod. AgentSpec is the real schema now, and the
                                    event union is DERIVED from @alineo-labs/schema's definitions
apps/docs/                        — the documentation site (Next.js static export)
apps/telemetry/                   — anonymous CLI usage telemetry receiver
apps/registry/                    — the agent-spec registry, and the published JSON Schema
apps/sandbox/                     — the browser playground
```

### Key design points

**Sandbox as first-class object**: `client.sandbox()` returns a live `SandboxHandle` object. You hold it, call methods on it, and call `sb.close()` when done. Multiple sandboxes → multiple variables. No special API.

**ExecHandle**: `sb.exec("cmd")` returns an `ExecHandle` — a `PromiseLike<ExecResult>` with `pipe()`, `stdout()`, and `result()`. `await sb.exec("cmd")` gives `{ stdout, stderr, exitCode }`. Streaming: `await sb.exec("cmd").pipe(process.stdout)`.

**Durable ledger**: Every exec is logged to the adapter as `exec_start` → `exec_event`s → `exec_complete`. `sb.checkpoint()` snapshots the container and writes `checkpoint_created`. On `client.resume(sandboxId)`: restores from the last snapshot, returns cached results for execs completed before the checkpoint, runs the rest live. Invisible to the user.

**Lazy workflow layer**: `@alineo-labs/workflow` provides `workflow(client).sandbox(opts, fn).pipe(sink)`. The `fn` callback receives a `SandboxBuilder` — all methods queue ops synchronously. The queue is flushed when `.pipe()` or `.result()` is awaited. One `await` at the end regardless of workflow complexity.

**Storage adapter**: `SandboxClientOptions.adapter` accepts any `IStorageAdapter`. Pass `new SQLiteAdapter("./alineo.db")` for local dev or `new PostgresAdapter(connectionString)` for production. The adapter is initialised lazily on first use — no `connect()` call needed. On process exit, `beforeExit` closes the adapter automatically; explicit teardown is not required for scripts.

**Concurrency limits**: `SandboxClientOptions.maxConcurrency` caps simultaneous active sandboxes. `client.sandbox()` awaits a semaphore slot; the slot is released when `sb.close()` is called.

**Hooks**: `SandboxHooks` provides lifecycle callbacks: `onSandboxCreated`, `onExecStart`, `onExecComplete`, `onCheckpoint`, `onSandboxClosed`, `onSandboxFailed`. Pass via `SandboxOptions.hooks`. Use `otelHooks(tracer)` from `@alineo-labs/otel` for OpenTelemetry tracing.

**execd readiness**: OpenSandbox reports a sandbox as "Running" before execd is ready. `resolveExecClient()` calls `getEndpoint()` once (each call returns a different ephemeral proxy port) then polls `listContexts()` until execd responds.

**Sandbox entrypoint**: Always `["tail", "-f", "/dev/null"]` — `/bin/bash` exits immediately without a TTY, killing the container. `client.sandbox()` sets this automatically.

**Resource limits required**: `SandboxOptions.resources` (`{ cpu: string; memory: string; gpu?: string }`) is required — the OpenSandbox server rejects requests without it. Always pass at least `{ cpu: "500m", memory: "256Mi" }`. This applies to `client.sandbox()`, `workflow().sandbox()`, and every step in `workflow().sequence()`.

**Server proxy mode**: When OpenSandbox runs in Docker (via `alineo init`), sandbox containers are on a bridge network and their IPs are unreachable from the host. Set `useServerProxy: true` in `SandboxClientOptions` to route execd and proxy traffic through the server (`?use_server_proxy=true` on `getEndpoint`). The server then returns `{eip}/sandboxes/{id}/proxy/{port}` URLs that are reachable from the host. The server config must have `eip = "http://localhost:8080"` set — `alineo init` writes this automatically.

## Environment variables

`Sandbox` is configured via constructor options, not environment variables. The consuming application is responsible for reading env vars and passing them in:

| Option | Description |
|---|---|
| `baseUrl` | OpenSandbox server URL (e.g. `http://localhost:8080`) |
| `apiKey` | OpenSandbox API key (empty string for local dev) |
| `adapter` | `IStorageAdapter` implementation (SQLiteAdapter or PostgresAdapter) |
| `maxConcurrency` | Max simultaneous workflow runs (default: unlimited) |
| `useServerProxy` | Route execd/proxy traffic through the server — required when server runs in Docker via `alineo init` (default: `false`) |

## Local OpenSandbox setup

### Option 1 — alineo init (recommended)

`bunx alineo-cli init` starts OpenSandbox in a Docker container (`opensandbox/server:latest`) and writes `~/.config/alineo/server.toml` and `.alineo/config.json` automatically. This is the preferred path for users running the full alineo workflow.

When using a server started this way, pass `useServerProxy: true` to `new Sandbox(...)` — direct container IPs are not reachable from the host over Docker's bridge network.

OpenSandbox's snapshot-metadata db is bind-mounted from `~/.config/alineo/opensandbox-data` into the container (see `serverDataDir()` in `packages/cli-shared/src/config.ts`), so `Alineo.start()`'s cached-snapshot fast path survives the container being fully removed and recreated, not just stopped/started — fixes the silent full-rebuild-on-every-restart issue tracked as #20.

### Option 2 — uvx (manual)

Run `uvx opensandbox-server` with `~/.sandbox.toml`:

```toml
[server]
host = "127.0.0.1"
port = 8080

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.22"

[docker]
network_mode = "bridge"

[ingress]
mode = "direct"

[egress]
mode = "dns"
```

The `uvx` path does not need `useServerProxy` — the server is on the host, so direct container IPs are reachable.

## SDK focus

We are currently focused exclusively on making the **TypeScript sandbox client SDK** (`packages/sdks/typescript`, published as `@alineo-labs/sandbox`) full-featured and production-ready. Python SDK is maintained but not the priority. Do not add new features to the Python SDK unless explicitly asked.

## Releases

The TypeScript sandbox client SDK (`packages/sdks/typescript`, published as `@alineo-labs/sandbox`) is published to npm via changesets, same as every other publishable package (`alineo`, `alineo-cli`, `@alineo-labs/*`). Every PR that changes publishable packages needs a changeset (`bunx changeset`). CI enforces this. Releases are cut automatically via `changesets/action` on merge to `main`.

> **Changeset must be committed** before CI will pass — `bunx changeset status --since origin/main` reads from git history, not disk.

## One vocabulary, checked in CI

One person meets the CLI, the SDK, the daemon's HTTP API, the MCP tools and the event stream.
Each of those used to pick its own spelling, and each did — `spawn` meant "create a root agent"
in the CLI and "create a child" in the SDK, so anyone who learned one and moved to the other was
actively misled.

The words live as data in `@alineo-labs/schema` (`SUBJECTS`, `VERBS`), and
`bun run check:vocabulary` (`scripts/check-vocabulary.ts`, a CI step) fails on:

| Check | Asserts |
|---|---|
| CLI | every registered command is a `VERB` or an allowlisted noun, and each usage line starts with the command it documents |
| Strings | every command quoted in help, error, guidance or doc text resolves to a real one — this is what would have caught **alineo ps**, documented in the source for months and never real |
| MCP | every tool is `{subject}_{verb}`, or a bare verb when it has no subject (`init`) |
| HTTP | every alineod path segment after a resource id is a `VERB` or a `SUBJECT` |
| Events | every event name the codebase emits resolves to a definition, via `renames.ts` where it has an old one |
| Durability | alineod's `PERSISTED_HARNESS_EVENTS` agrees with the definitions' `durable` flags, both ways |

The shapes of the names, for writing a new one:

- **CLI** `alineo <verb> [args]` · **SDK method** the verb · **SDK class** the subject
- **HTTP** `/{subjects}/:id/{verb}` · **MCP tool** `{subject}_{verb}` · **Event** `{subject}.{past-tense verb}`

Events are namespaced **by subject, not by the layer that emits them** — `agent.spawned`, not
`alineod.agent_spawned`. Someone reading one mixed stream needs to know what an event is *about*.

Two things the check can't see, so they're conventions:

- **A retired command name goes in bold prose (`**alineo fork**`), never in a code span.** A
  reader — or a model — skimming for something to run must never find a dead command formatted
  as though it were live. Naming-history notes pass the check because of this.
- **Renaming an event by hand is a trap.** `text`, `checkpoint` and `snapshot` are ordinary
  English words; a bare-word find-and-replace turns "partial text" into "partial
  message.updated". Match code spans and verbatim log/SSE samples only. This was hit twice.

## Docs are unversioned — there is no version cut to owe

`apps/docs/content/docs/` is one tree per product (`core`, `agent`, `alineo`, `alineod`,
`workflow`, `cookbooks`, `examples`, `playground`). **Edit the page in place.**

It was not always so. `core` and `alineo` were versioned into `vX.Y/` folders, with an "epoch"
tracking `@alineo-labs/sandbox`'s published `major.minor`, a `cut-doc-version.ts` script in the
release flow, and a CI job failing any PR where the epoch had moved past the latest folder.
**All of that was removed in #232** — no `apps/docs/scripts/`, no `vX.Y` folders, no check.

What survives is `apps/docs/public/_redirects`, which keeps the already-indexed versioned URLs
(`/docs/core/0.3`, `/docs/core/v0.1`, …) resolving to the live unversioned page. Add a rule
there when a page moves — see the `commands/fork` → `commands/spawn` entries from the CLI verb
rename for the shape, including the case where a URL is deliberately *not* redirected because
it still names a live page.


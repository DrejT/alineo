# @drej/agent

## 0.1.1

### Patch Changes

- 0240c0f: Raise `sseStream`'s default inactivity timeout from 60s to 3 minutes. Pi's own `bash` tool is
  not incrementally streamed, so a single tool call that spins up a whole child sandbox (e.g. a
  master session running `alineo fork` on itself, as in `examples/rlm-repo-fanout`) produces zero
  `AgentEvent`s for as long as that call takes — child sandbox provisioning plus Pi CLI install
  alone routinely took 30-150s+ in testing, regularly exceeding the old 60s default and killing
  otherwise-healthy sessions mid-run. Confirmed via a real `examples/rlm-repo-fanout` run: the
  exact `alineo fork` tool call that previously crashed the host script with `PromptTimeoutError`
  at 60s now completes normally under the new default. Callers needing something tighter or
  looser can still pass `inactivityTimeoutMs` explicitly to `prompt()`.

## 0.1.0

### Major Changes

- 2a61e0c: Rename the project from drej to alineo. Breaking change: every published package's name
  changed.

  - SDK: `drej` → `alineo` (`import { Drej } from "drej"` → `import { Alineo } from "alineo"`).
    `DrejError`/`DrejOptions` → `AlineoError`/`AlineoOptions`.
  - CLI: `drejx` → `alineo-cli` (npm package name), binary command `drejx` → `alineo`
    (`drejx init` → `alineo init`, etc). `~/.config/drejx/` → `~/.config/alineo/`,
    project-local `drej.config.json` → `alineo.config.json`, `.drej/` → `.alineo/`.
  - Scoped packages: `@drej/*` → `@alineo-labs/*` across all 14 previously-scoped packages.
  - Environment variables: `DREJ_*`/`DREJX_*` → `ALINEO_*` (the two-prefix split collapses to
    one now that the CLI binary and SDK class share the same root name).

  This is a code-level rename only — package/CLI/env-var/config-path identifiers. GitHub
  org/repo, deploy domains, and Cloudflare project names are unchanged in this pass (that
  infra isn't provisioned under the new name yet).

### Minor Changes

- 637b678: Add `runId` — a first-class way to correlate sandboxes belonging to the same logical run, surfaced through `SandboxDetails.runId` and filterable via `client.sandboxes.list({ runId })`/`listByName({ runId })`.

  - `SandboxOptions.runId` (optional, defaults to a fresh `crypto.randomUUID()` if omitted) is recorded on every sandbox-creation path (`client.sandbox()`, `client.resume()`, `client.restoreSnapshot()`, `sb.fork()`, environment-backed sandboxes) — a resumed, restored, or forked sandbox always inherits its origin's `runId` rather than getting a new one.
  - `sb.fork(tag?, runId?)` gains an optional explicit override, needed across a process boundary (e.g. `alineo fork`, which re-`Agent.attach()`es in a brand-new CLI process with no access to the original in-memory closure) — same reasoning `ALINEO_SPAWN_DEPTH` already established, generalized to run identity.
  - `Agent.load()`/`Agent.resume()` accept an optional `runId`, bake `ALINEO_RUN_ID` into the sandbox's env alongside `ALINEO_SPAWN_DEPTH`/`ALINEO_MAX_AGENTS`/`ALINEO_OBSERVABILITY`, and expose it as `agent.runId`. `Agent.spawn()`/`alineo fork` force-inherit it into every forked child, tamper-resistant like the existing budget fields. `alineo spawn` gains a `--run-id` flag.
  - `runId` also rides along in `SandboxOptions.metadata`/`CreateSandboxOptions.metadata` at every creation path, since the ledger alone can't correlate sandboxes across separate adapter instances (e.g. a forked child writing to its own in-container ledger file) — the OpenSandbox control plane is the one channel every caller shares regardless of adapter, and its `Sandbox` type already declares (and, verified against a live server, actually echoes back) `metadata`.
  - Both storage adapters (`@alineo-labs/sqlite`, `@alineo-labs/postgres`) extend their aggregation query to surface `runId` on `SandboxDetails` and support it as a `ListSandboxOptions` filter — no schema migration needed, read out of the existing JSON payload.

### Patch Changes

- e1f6621: Fix `alineo init`'s Docker container silently losing every cached agent snapshot whenever it's
  removed and recreated (host reboot with no restart policy, `docker system prune`, a stray
  `docker rm`) — not just restarted. OpenSandbox itself persists snapshot metadata durably in a
  SQLite db meant to survive the server process restarting, but `alineo init` never bind-mounted
  that db's directory to the host, so it only ever survived alongside the container's own
  lifecycle. `~/.config/alineo/opensandbox-data` is now bind-mounted into the container at `/data`,
  with `[store].path` pinned explicitly in the generated `server.toml`, so the durability
  guarantee OpenSandbox already provides actually holds (fixes #20).

  Also: `Agent.load()`'s snapshot-restore fallback now logs the real error instead of a bare
  "snapshot stale, rebuilding..." — useful for any other reason a cached snapshot might fail to
  restore, not just this one.

- bd95393: Remove `private: true` from the 10 publishable packages so they can actually be published to
  npm. No functional or API changes — this is the last step of npm-publish readiness (repository
  URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
- 735ecf7: `Agent.prompt()`'s SSE stream had no timeout at all — if the underlying Pi process ever went
  silent (the bridge's own keep-alive heartbeat kept the raw connection alive regardless), every
  caller up the chain blocked forever with zero visibility. Added an inactivity timeout, keyed off
  real `AgentEvent`s rather than raw stream activity so the heartbeat can't mask a genuine stall,
  via a new `inactivityTimeoutMs` option (default 60s) and a new `PromptTimeoutError`. `alineo
fork`/`spawn`/`prompt --prompt` now also expose this as `--timeout SECONDS`, and their `--json`
  output reports `toolCalls` alongside `reply` so a turn that made tool calls but produced no
  final text isn't indistinguishable from one that did nothing at all.
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.
- Updated dependencies [a9564e1]
- Updated dependencies [b03ae19]
- Updated dependencies [7acdf32]
- Updated dependencies [bd95393]
- Updated dependencies [2a61e0c]
- Updated dependencies [637b678]
- Updated dependencies [acc51e3]
  - @alineo-labs/core@1.0.0
  - alineo@1.0.0

## 0.6.2

### Patch Changes

- Updated dependencies [cc5059a]
  - @drej/core@0.6.3
  - drej@0.10.4

## 0.6.1

### Patch Changes

- 5a01e36: Docs only, no behavior change. Fixed JSDoc comments that had drifted from the
  code they document — mostly leftovers from the `sandbox.ts`/`agent.ts` module
  split:

  - `SandboxCore.exec()`'s interactive-mode doc was missing `close()` from the
    `InteractiveExecHandle` method list.
  - `fork()` (both the `Sandbox` method and the underlying `lifecycle.ts`
    function) claimed to be equivalent to `checkpoint()` + `Drej.resume()`; it's
    actually equivalent to `checkpoint()` + `Drej.restoreSnapshot()` — no exec
    history is replayed, unlike `resume()`.
  - `SandboxInternal`'s doc referenced a nonexistent `_replayCache` field (the
    real field is `replayCache`, not private).
  - `SandboxError`'s doc said it's only thrown for create/boot/`Running`
    failures; it's also thrown for the paused-sandbox guard, unsupported
    `fork()`, and snapshot failures.
  - `StepTimeoutError`'s doc referenced a nonexistent `RunOptions.stepTimeoutMs`
    and a rollback behavior that was never implemented — this class is
    currently unused; the doc now says so instead of describing a mechanism
    that doesn't exist.
  - `SandboxOptions.name`'s doc referenced a "shortRunId" that isn't a real
    concept in this codebase; the actual default uses the first 8 characters of
    `sandboxId`.
  - `Agent`'s class-level `@example` called `Agent.load()` without the required
    `opts.adapter` argument.
  - `Agent.attach()`'s doc said its main caller is `drejx spawn`; it's actually
    `drejx fork` (`drejx spawn` calls `Agent.load()`, not `attach()`).
  - `Agent.spawn()`'s doc referenced `fork()`/`clone()` as being "above" it in
    the file; they're below.

  Docs site (`apps/docs/`, not a published package) updated to match, plus a
  broader sweep found unrelated pre-existing drift fixed in the same pass:

  - `core/api-reference/errors.mdx`'s `SandboxError` hierarchy summary was
    narrower than its own detailed section below it — broadened to match.
  - `core/patterns/fork.mdx` now calls out that `fork()` matches
    `restoreSnapshot()`, not `resume()`.
  - Added `restoreSnapshot()` and `connect()` sections to
    `core/api-reference/drej-client.mdx` — both are public `Drej` client
    methods that had no documentation anywhere on the site. `resume()`'s
    signature was also missing its `opts?: { tag?: string }` param.
  - `core/concepts/sandboxes.mdx` showed `SandboxOptions.resources` as fully
    optional (`{ cpu?, memory?, gpu? }`); `cpu`/`memory` are actually required.
  - `core/building/exec.mdx`'s `execCode()` example omitted the `entrypoint`
    override that `opensandbox/code-interpreter` requires to actually start,
    and its "stateful execution" example hand-rolled a context object instead
    of calling `createCodeContext()` (contradicting the code's own docstring).
  - `core/building/file-ops.mdx` claimed all file operations are queueable in
    `SandboxBuilder`; only `writeFile`/`readFile`/`deleteFile`/`moveFile` are.
  - `core/api-reference/index.mdx` and `core/concepts/storage-adapters.mdx`
    said "`Drej` has no `connect()`" — false, conflating the storage adapter's
    optional `connect()`/`close()` with the client's own real `connect()`
    method. Reworded to distinguish the two.
  - `core/adapters/custom.mdx` and `core/adapters/postgres.mdx` overstated
    adapter `close()` as running "when the process exits" — it only runs on
    `beforeExit`, which long-running servers never reach.
  - `agent/api-reference/agent.mdx`: `ThinkingLevel` documented as
    `"low" | "medium" | "high"`, missing `"none"`; default `serverUrl` shown as
    `http://localhost:8080` instead of the actual `http://127.0.0.1:8080`
    (the source has an explicit comment warning against `"localhost"` due to
    IPv6/IPv4 resolution issues on some hosts).
  - `workflow/building/parallel-sequence.mdx`'s `SequenceStep` interface
    omitted `env`/`timeout` fields, showed `resources` as optional when it's
    required, and claimed `prev` is `{ stdout: "", vars: {} }` on the first
    step when it's actually `undefined`.
  - `workflow/building/control-flow.mdx` reused the name `FlushContext` for a
    3-field shape that doesn't match the real (4-field) exported
    `FlushContext` interface — renamed to avoid the collision.
  - `drejx/commands/add.mdx` claimed `add` throws without a prior `drejx init`;
    it actually falls back to an auto-created global config.
  - `drejx/registry/schema.mdx` said spec validation only checks `name`/`cli`;
    it also validates `spawnDepth`/`maxAgents`.
  - `drejx/commands/index.mdx` claimed every agent-lifecycle command addresses
    sessions by sandbox ID; `fork`/`logs` actually address by name.
  - Fixed a broken same-page anchor link in `drejx/commands/fork.mdx`, and two
    more `localhost:8080` → `127.0.0.1:8080` corrections in
    `drejx/commands/init.mdx` and `drejx/getting-started/quickstart.mdx`.

- 5a01e36: Docs only, no code change. `packages/cli/README.md` had drifted badly — it
  documented only 4 of 10 commands (`init`/`add`/`list`/`remove`), leaving the
  entire "Agent — session lifecycle" group (`spawn`/`prompt`/`fork`/`agents`/
  `kill`/`logs`) undocumented, and described `drejx list`/`drejx remove` as
  operating on a `.drej/sandboxes.json` file that no longer exists. Rewrote it
  to cover every command, the `spawnDepth`/`maxAgents` recursive-spawning
  semantics, and the `pi install npm:drejx` distribution path.

  `packages/agent/README.md` was missing `Agent.attach()` and `agent.spawn()`
  entirely — the sandbox-level forking capability — despite otherwise being
  accurate. Added both, plus the `spawnDepth`/`maxAgents` spec fields to the
  Agent spec table.

  Root `README.md`'s packages table was missing `@drej/flue` — same drift
  pattern already fixed in `CLAUDE.md` during the codebase restructure, just
  never applied here.

  Also fixed a longstanding bug (present since the README's first commit, well
  before this session): every `Agent.load()`/`Agent.resume()` example across
  `packages/agent/README.md` and the docs site omitted the required
  `opts.adapter` field, so copy-pasting any of them would fail to compile.
  `@drej/agent` deliberately has no storage-adapter dependency of its own — the
  fix is docs-only (construct a `SQLiteAdapter`/`PostgresAdapter` explicitly in
  every example), not a behavior change to the SDK itself.

  Docs site (`apps/docs/`, not a published package) also updated to match:
  added the 6 missing `drejx` command pages (`spawn`/`prompt`/`fork`/`agents`/
  `kill`/`logs`), `Agent.attach()`/`agent.spawn()` in the API reference, and
  corrected several pages that still claimed "drejx never touches a sandbox" —
  no longer true since it gained a full agent-session-lifecycle command group.

- Updated dependencies [5a01e36]
  - @drej/core@0.6.2
  - drej@0.10.3

## 0.6.0

### Minor Changes

- 7bd8e5d: Renamed CLI commands: `drejx run` → `drejx spawn` (start a fresh, independent agent sandbox from a spec), and the previous `drejx spawn` (fork a running session's own live sandbox into a child) → `drejx fork`. "Spawn" now consistently means "create," matching how it reads; "fork" now names the operation that actually forks live state, matching `Agent.spawn()`'s own doc language.

  Renamed `--spawn-depth` to `--depth` on `spawn`/`fork` (POSIX-style, and paired now with the new `--max` flag below).

  Added a `--max` flag (and matching `maxAgents` spec field) — a separate, optional ceiling on total descendants for a lineage, distinct from `--depth`'s nesting-depth limit. Unset means uncapped for this dimension; `--depth` alone still gates whether spawning/forking is allowed at all. Enforced per-lineage only — sibling branches forked in parallel don't share or coordinate this budget with each other. Implemented the same tamper-resistant env-counter pattern as `spawnDepth`/`DREJX_SPAWN_DEPTH`, via a new `DREJX_MAX_AGENTS` env var.

  `drejx prompt`/`drejx kill`'s `--spec`-adjacent internals and the Pi extension's `drejx_run` tool are updated to `drejx_spawn` to match the rename.

  `drejx agents` now cross-checks the ledger's "Running" sandboxes against the live OpenSandbox control plane before listing them — a sandbox that died ungracefully (crashed, expired via OpenSandbox's own TTL, deleted outside drej) previously stayed listed as "Running" forever, since nothing ever told the ledger otherwise.

### Patch Changes

- e343eab: Internal restructure: extract the ~540-line Node.js bridge script out of
  `packages/agent/src/adapters/pi.ts`'s `BRIDGE_SCRIPT` template literal into a
  real file, `packages/agent/src/adapters/pi-bridge.js` — it now gets actual
  lint/format coverage instead of living as an opaque string with zero tooling
  support. Read at runtime relative to its own module location and copied
  into `dist/` alongside `index.mjs` by tsdown's `copy` config, so resolution
  works identically in dev and the published package. (Bun's native text
  import attribute was tried first but isn't understood by rolldown, the
  bundler this package's publish build actually uses.)

  No behavior change — the bridge script's content is byte-identical, verified
  by evaluating the original template literal and diffing against the
  extracted file before making the switch. Part of the codebase restructure
  plan (plans/codebase-restructure.md, Phase 4).

- e78be8b: Fix the Pi bridge's `/prompt` and `/bash` SSE responses dying on OpenSandbox's generic port-proxy: that endpoint proxies through an httpx client with no configured read timeout (defaults to 5s), so any gap that long between bytes written — model thinking time, a slow tool call — got the proxy's connection killed, surfacing as a 500 or a silently-truncated stream. A periodic `: ping` SSE comment now keeps that idle timer from firing during long-running prompts and bash calls.
- e78be8b: Fix the Pi bridge silently dropping a rejected `/prompt` call. When Pi rejects a prompt outright (e.g. no API key configured for the provider), its ack isn't tracked the way `/bash` results are, so the bridge previously just discarded it — the client's SSE stream would sit open indefinitely (kept alive by the heartbeat) instead of ever completing. The bridge now forwards the rejection as an error and ends the stream immediately.
- e78be8b: Fix `drejx spawn` when run from inside its own sandbox (the actual `Agent.spawn()` use case): it previously looked up the caller's own running session by name in the local ledger, but a session created via `Agent.load()` from a host process has its `sandbox_created` event recorded in a different `IStorageAdapter` than whatever `drejx spawn` opens from `drej.config.json` inside the container — two independent SQLite files that can never see each other. `drejx spawn` now resolves its own sandbox ID from `DREJ_SANDBOX_ID`, an env var every agent-creation path (`Agent.load()`, `Agent.resume()`, `Agent.spawn()`) now writes to `/etc/drej-env`, falling back to the old ledger lookup only when that's unset.

  Also fixes `Agent.attach()` throwing "Unable to connect" on this same self-attach path: it read `/etc/drej-env` via a network exec call to the sandbox's own externally-facing endpoint, which Docker's default bridge network can't hairpin a container back to itself through. When the target sandbox ID matches this process's own `DREJ_SANDBOX_ID`, it now reads the file from the local filesystem directly instead.

- e343eab: Internal restructure: split `packages/agent/src/agent.ts` (688 lines, one
  class with ~30 methods) into `packages/agent/src/agent/` — `validation.ts`
  (spawn-depth/max-agents helpers, moved verbatim), `internal.ts` (a
  package-private `AgentInternal` facade), `factory.ts` (the `load`/`resume`/
  `attach`/`spawn` bodies, which own nearly all of the real complexity —
  snapshot restore, env resolution, spawn-depth/max-agents enforcement),
  `session-control.ts`, `model.ts`, `introspection.ts`, `lifecycle.ts` (the
  ~20 thin `_adapter` delegator methods, grouped by concern), and a thin
  `agent.ts` composing them.

  No public API change — `Agent`'s method signatures, return types, and
  behavior are identical. Part of the codebase restructure plan
  (plans/codebase-restructure.md, Phase 3).

- Updated dependencies [e343eab]
  - @drej/core@0.6.1
  - drej@0.10.2

## 0.5.0

### Minor Changes

- dd89d67: Add `Agent.spawn()`: fork a running agent's live sandbox — filesystem, installed packages, checked-out state — into an independent child running its own Pi bridge, instead of always starting a child from a spec's own snapshot. Exposed via `drejx spawn <name> <child-spec> [--prompt] [--spawn-depth N] [--json]`.

  - `AgentSpec` gains an optional `spawnDepth` field, translated by `Agent.load()`/`Agent.resume()` into `DREJX_SPAWN_DEPTH`. `Agent.spawn()` refuses unless this is a positive integer, and force-computes `depth - 1` into the child regardless of what the child's own spec says — a tamper-resistant counter, not something a spec author or the model can hand-propagate incorrectly.
  - The child's environment is resolved fresh from its own spec, then every name the parent's own env declares is explicitly `unset` in the exact shell command that starts the child's bridge — verified live that `sb.fork()`'s forked container otherwise carries the parent's env vars forward regardless of what's written to `/etc/drej-env`.
  - `Agent.attach()`: connects to a running sandbox without touching its Pi bridge, unlike `resume()` — needed because `drejx spawn` runs as a CLI process invoked by the very Pi bash-tool call it's attaching to; going through `resume()` there would kill the bridge running the process making the call.
  - Fixes two pre-existing gaps in `drej`'s `client.restoreSnapshot()` and `client.connect()`, found while building this: neither wired up the `fork` dependency on the `Sandbox` it returned, so `.fork()` (and now `Agent.spawn()`) would throw "fork() is not supported on this sandbox" for any agent loaded from its snapshot fast path, or attached to via `Agent.attach()`. `client.connect()` now accepts an optional `resources` param to enable this.

### Patch Changes

- Updated dependencies [dd89d67]
  - drej@0.10.1

## 0.4.0

### Minor Changes

- b7aaa2f: Add `agent.getState()`, wrapping Pi's `get_state` RPC command. Returns the current model, thinking level, streaming/compaction status, queue modes, and session identity — the only piece of Pi's RPC surface that wasn't already exposed (every other method already had an `Agent` wrapper). Needed to show live agent status (current model, thinking level, auto-compaction) without guessing from side effects of other calls.

### Patch Changes

- 5055755: `AgentSpec.cliVersion` now actually pins the installed Pi CLI version. Previously it was only used as a setup-hash cache-key input — `install()` always ran `npm install -g @earendil-works/pi-coding-agent` with no version qualifier, so setting `cliVersion` had no effect on which version got installed. `install()` now runs `npm install -g @earendil-works/pi-coding-agent@<cliVersion>` when `cliVersion` is set (accepts an exact version, a semver range, or a dist-tag like `"latest"`), and falls back to the bare package name when omitted.
- 9cc6b08: Default `serverUrl` (in `drej.config.json` / `readProjectConfig`) is now `http://127.0.0.1:8080` instead of `http://localhost:8080`. On hosts where `localhost` resolves to `::1` first but OpenSandbox only listens on IPv4, the old default caused every request — including `Agent.load()`'s sandbox creation — to fail with a socket error instead of connecting.
- Updated dependencies [13b826b]
- Updated dependencies [fa18120]
  - drej@0.10.0
  - @drej/core@0.6.0

## 0.3.2

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

- Updated dependencies [a4856f1]
  - @drej/core@0.5.3
  - drej@0.9.3
  - @drej/sqlite@0.3.4

## 0.3.1

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

- Updated dependencies [a91651c]
  - @drej/core@0.5.2
  - drej@0.9.2
  - @drej/sqlite@0.3.3

## 0.3.0

### Minor Changes

- fdc25db: Complete Pi RPC coverage: forward all Pi stdout events and implement all remaining RPC commands.

  **New `AgentEvent` variants (11):** `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update` (with `delta` field renaming Pi's `assistantMessageEvent`), `message_end`, `queue_update`, `compaction_start`, `compaction_end`, `extension_error`.

  **New `Agent` methods (9):**

  - `abortBash()` — stop a running bash command without cancelling the whole prompt
  - `getSessionStats()` — token usage, cost, and message counts (`SessionStats`)
  - `getLastAssistantText()` — retrieve the last Pi response without iterating a stream
  - `getForkMessages()` — list fork entry points in the current session
  - `getCommands()` — introspect Pi slash commands, skills, and prompt templates (`PiSlashCommand[]`)
  - `setSessionName(name)` — set a display name for the current session
  - `setSteeringMode(mode)` — control how queued steers are applied (`"all" | "one-at-a-time"`)
  - `setFollowUpMode(mode)` — control how queued follow-ups are sent (`"all" | "one-at-a-time"`)
  - `exportHtml(outputPath?)` — export an HTML transcript to the sandbox filesystem

  **New exported types:** `SessionStats`, `PiSlashCommand`.

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- cf9af70: Fix extension_ui_request bug and add auto-retry API

  - **Bug fix**: `extension_ui_request` events from Pi extensions were silently dropped by the bridge. Dialog requests (select/confirm/input/editor) now receive an immediate `cancelled` response so Pi never stalls indefinitely. All extension UI events are forwarded through the stream as a new `extension_ui` AgentEvent.

  - **New**: `agent.setAutoRetry(enabled)` — enable or disable Pi's built-in exponential-backoff retry on transient errors (429, 5xx). On by default (3 attempts, 2 s / 4 s / 8 s).

  - **New**: `agent.abortRetry()` — abort an in-progress retry immediately.

  - **New events**: `auto_retry_start` and `auto_retry_end` are now forwarded through the AgentStream with full context (attempt, maxAttempts, delayMs, errorMessage, finalError).

- bca2a6b: Fix JSDoc comments that no longer matched the code they document (stale `DrejClient` references, incorrect claims about `DrejError`, `watchMetrics()`, `resume()`, `exec()` ledger logging, `CommandError`, `computeSetupHash`, `bash()` streaming, and the `when()` predicate context), and flag two fields (`AgentSpec.cliVersion`, `.metadata`, `.registryDependencies`) and one known concurrency limitation (`FlushContext` under `forEach({ concurrency > 1 })`) that are currently no-ops/buggy rather than doing what they were documented to do. No behavior changes — doc-only.
- 7fb9d35: Reword `AgentSpec.cliVersion`/`.metadata`/`.registryDependencies` JSDoc to state their current behavior as plain fact instead of flag-style "NOT YET IMPLEMENTED" annotations. No behavior change.
- 3f362d1: Enable npm provenance for published packages.
- Updated dependencies [34cfa8b]
- Updated dependencies [bca2a6b]
- Updated dependencies [3f362d1]
  - @drej/core@0.5.1
  - drej@0.9.1
  - @drej/sqlite@0.3.2

## 0.2.0

### Minor Changes

- f803858: Agent snapshotting: `Agent.load()` checkpoints the sandbox after Pi install and restores from the snapshot on subsequent loads, reducing startup from ~90s to ~8s. `checkpoint()` now returns the snapshot ID. New `Drej.restoreSnapshot(snapshotId, name, resources)` creates a sandbox from a snapshot without exec replay. `Agent.load()` accepts `{ rebuild: true }` to force reinstall.
- 3f55f48: Surface Pi tool call events through `AgentStream`

  `Agent.prompt()` and `Agent.bash()` now return `AgentStream` (an
  `AsyncIterable<AgentEvent>`) instead of `AsyncIterable<string>`. Each
  `AgentEvent` is a discriminated union:

  - `{ type: "text"; text: string }` — Pi's response text (as before)
  - `{ type: "tool_start"; toolCallId; toolName; args }` — Pi began a tool call
  - `{ type: "tool_update"; toolCallId; toolName; partialResult }` — streaming tool progress
  - `{ type: "tool_end"; toolCallId; toolName; result; isError }` — tool finished

  Use the new `textOnly(stream)` helper to filter to text only (drop-in for old
  `PromptStream` loops). `PromptStream` is kept as a deprecated type alias.

- e9a9110: Add `setup` steps to `AgentSpec`: declarative bash commands that run after Pi CLI install and are baked into the snapshot. Any change to the steps automatically invalidates the snapshot cache.
- b773030: Pi adapter: SSE streaming on prompt/bash responses, bash via ack-based pendingCmds (output extracted from RPC response data field), streamingBehavior support for mid-flight injection, steer acknowledgment, and 13 additional RPC commands (setModel, cycleModel, setThinkingLevel, cycleThinkingLevel, setAutoCompaction, compact, getMessages, getAvailableModels, clone, fork, followUp, abort, getLogs).
- c81c77d: Sandbox API extensions: `pause()` / `resume()`, `createSession()` / `BashSession` persistent shell sessions, `diagnosticLogs()` / `diagnosticEvents()`, `watchMetrics()` streaming, and `Drej.connect()` for attaching to an already-running container. Agent: `Agent.resume(sandboxId)` to reconnect a new host process to a live agent sandbox (restarts the bridge with `--continue`).

### Patch Changes

- a0c1eee: Add README to each published package so npm shows documentation on the package page.
- Updated dependencies [a0c1eee]
- Updated dependencies [f803858]
- Updated dependencies [c81c77d]
  - drej@0.9.0
  - @drej/sqlite@0.3.1
  - @drej/core@0.5.0

## 0.1.1

### Patch Changes

- 2c2eb16: Add JSDoc to all public exports: `Agent` class, `AgentSpec` interface fields, `PromptStream` type, `DrejAgentConfig`, and `readProjectConfig`.
- Updated dependencies [10417e3]
- Updated dependencies [5a63143]
- Updated dependencies [416bc72]
- Updated dependencies [f83ccf2]
- Updated dependencies [0398728]
- Updated dependencies [4f79c8e]
- Updated dependencies [2ed4de7]
- Updated dependencies [02bcb01]
- Updated dependencies [2bbd8dc]
- Updated dependencies [599d707]
  - drej@0.8.0
  - @drej/core@0.4.0
  - @drej/sqlite@0.3.0

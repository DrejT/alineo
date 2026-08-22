# @drej/core

## 0.2.0

### Minor Changes

- d628de4: **Breaking:** the `Sandbox` class is renamed to `SandboxHandle`. Part of the naming inversion
  tracked in [#182](https://github.com/DrejT/alineo/issues/182): the top-level `alineo` package
  becomes the sandboxed-agent API and `@alineo-labs/sandbox` becomes the sandbox-client API, which
  frees up `Sandbox` for the client's own class name — this package's per-instance class needed a
  new name to avoid colliding with it, and `SandboxHandle` was chosen to match the existing
  `ExecHandle`/`InteractiveExecHandle` convention.

  ```diff
  -import type { Sandbox } from "@alineo-labs/core";
  +import type { SandboxHandle } from "@alineo-labs/core";
  ```

  Most consumers get this type through `alineo` or `@alineo-labs/sandbox`'s re-export rather than
  importing `@alineo-labs/core` directly — see those packages' own changeset entries.

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

- a9564e1: Add `composeHooks(hooks, opts?)` to merge multiple `SandboxHooks` into one, so more than one
  hooks-based adapter (e.g. `otelHooks(tracer)` plus a future billing hook) can attach to the
  same sandbox without hand-writing a merged object. Each hook invocation is isolated in its
  own try/catch — a throwing hook can't break sibling hooks or the sandbox operation that
  triggered them; failures are reported via the optional `onHookError` callback.
- 637b678: Add `runId` — a first-class way to correlate sandboxes belonging to the same logical run, surfaced through `SandboxDetails.runId` and filterable via `client.sandboxes.list({ runId })`/`listByName({ runId })`.

  - `SandboxOptions.runId` (optional, defaults to a fresh `crypto.randomUUID()` if omitted) is recorded on every sandbox-creation path (`client.sandbox()`, `client.resume()`, `client.restoreSnapshot()`, `sb.fork()`, environment-backed sandboxes) — a resumed, restored, or forked sandbox always inherits its origin's `runId` rather than getting a new one.
  - `sb.fork(tag?, runId?)` gains an optional explicit override, needed across a process boundary (e.g. `alineo fork`, which re-`Agent.attach()`es in a brand-new CLI process with no access to the original in-memory closure) — same reasoning `ALINEO_SPAWN_DEPTH` already established, generalized to run identity.
  - `Agent.load()`/`Agent.resume()` accept an optional `runId`, bake `ALINEO_RUN_ID` into the sandbox's env alongside `ALINEO_SPAWN_DEPTH`/`ALINEO_MAX_AGENTS`/`ALINEO_OBSERVABILITY`, and expose it as `agent.runId`. `Agent.spawn()`/`alineo fork` force-inherit it into every forked child, tamper-resistant like the existing budget fields. `alineo spawn` gains a `--run-id` flag.
  - `runId` also rides along in `SandboxOptions.metadata`/`CreateSandboxOptions.metadata` at every creation path, since the ledger alone can't correlate sandboxes across separate adapter instances (e.g. a forked child writing to its own in-container ledger file) — the OpenSandbox control plane is the one channel every caller shares regardless of adapter, and its `Sandbox` type already declares (and, verified against a live server, actually echoes back) `metadata`.
  - Both storage adapters (`@alineo-labs/sqlite`, `@alineo-labs/postgres`) extend their aggregation query to surface `runId` on `SandboxDetails` and support it as a `ListSandboxOptions` filter — no schema migration needed, read out of the existing JSON payload.

### Patch Changes

- b03ae19: Fix `Sandbox.close()` (and `pause()`) not disposing of exec-stream connections left
  deliberately open by `parseSSE`'s early-return optimization (see its comment, and
  opensandbox-group/OpenSandbox#1277 — execd's `/command` handler doesn't terminate its
  chunked response until a fixed post-completion sleep elapses). Without an explicit
  teardown, one of these dangling connections could still be ESTABLISHED by the time a
  script called `close()`, keeping the host process's event loop alive indefinitely
  instead of exiting. `ExecClient` now tracks these readers and force-cancels them via a
  new `disposeConnections()` method, called from `Sandbox.close()`/`pause()` once the
  sandbox is being torn down anyway and nobody cares if the (already broken) upstream
  proxy relay errors out.
- 7acdf32: Increase `resolveExecClient()`'s default retry budget from ~11s (15 retries, capped at 1s) to
  ~80s (45 retries, capped at 2s). A live `alineo fork` failure (issue #32) showed a child forked
  while its parent sandbox was busy running a real Chrome session took ~35s just to reach
  `Running`, then immediately exhausted the old budget before execd inside it had started
  accepting connections. An isolated repro of the identical fork from an idle parent (no
  concurrent browser load) reached execd-ready in under 400ms — the parent's own host-resource
  contention at fork time, not snapshot size, is what actually eats the budget, and that can't be
  scheduled around from here. Affording substantially more patience before giving up is the fix.
- bd95393: Remove `private: true` from the 10 publishable packages so they can actually be published to
  npm. No functional or API changes — this is the last step of npm-publish readiness (repository
  URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.
- Updated dependencies [b03ae19]
- Updated dependencies [bd95393]
- Updated dependencies [2a61e0c]
- Updated dependencies [acc51e3]
  - @alineo-labs/opensandbox@1.0.0

## 0.6.3

### Patch Changes

- cc5059a: Cancel the exec/code SSE stream as soon as the terminal event (`execution_complete` or `error`) arrives instead of reading until the server closes the connection. execd holds the HTTP stream open for a fixed interval after sending its last event, so every `exec()`/`execCode()`/session command was paying that delay on top of the real round trip — this cuts steady-state exec latency from roughly 1 second to tens of milliseconds.

  Also switch the fixed-interval polling in `waitForRunning`, `waitForSnapshot`, and `resolveExecClient` to start fast and back off toward the original interval, instead of sleeping the full interval on every tick regardless of how quickly the real state change lands. Measured against a local OpenSandbox server, this cut checkpoint latency from ~2s to ~300-500ms.

- Updated dependencies [cc5059a]
  - @drej/opensandbox@0.3.1

## 0.6.2

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

## 0.6.1

### Patch Changes

- e343eab: Internal restructure: split `packages/core/src/sandbox.ts` (869 lines, one
  class with 29 methods) into `packages/core/src/sandbox/` — `types.ts`,
  `resolve.ts`, `internal.ts` (a package-private `SandboxInternal` facade),
  `core.ts` (state + the exec-stream methods most tightly coupled to it),
  `files.ts`, `lifecycle.ts`, `observability.ts`, `bash-session.ts`, and a
  thin `sandbox.ts` composing them via delegation.

  No public API change — `Sandbox`'s method signatures, return types, and
  behavior are identical. Part of the codebase restructure plan
  (plans/codebase-restructure.md, Phase 2).

## 0.6.0

### Minor Changes

- fa18120: Add `sb.exec(cmd, { interactive: true })` for live, bidirectional PTY sessions — human-in-the-loop CLI access inside a sandbox. Returns an `InteractiveExecHandle` with `write()`, `resize()`, `signal()`, `close()`, and `attach()` in addition to the usual `stdout()`/`pipe()`/`result()`/`await` surface.

  Every `write()` is logged to the ledger alongside output, so a session still open at the last checkpoint is reconstructed on resume by replaying its recorded stdin for real against the freshly restored filesystem (OpenSandbox snapshots are rootfs-only — the original process is gone after resume, so this is the only way to re-derive shell state like exported vars or `cd`s).

  `@drej/opensandbox` gains a `PtyClient` wrapping execd's `/pty` REST + WebSocket protocol.

### Patch Changes

- Updated dependencies [fa18120]
- Updated dependencies [b2d7096]
  - @drej/opensandbox@0.3.0

## 0.5.3

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

- Updated dependencies [a4856f1]
  - @drej/opensandbox@0.2.3

## 0.5.2

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

- Updated dependencies [a91651c]
  - @drej/opensandbox@0.2.2

## 0.5.1

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- bca2a6b: Fix JSDoc comments that no longer matched the code they document (stale `DrejClient` references, incorrect claims about `DrejError`, `watchMetrics()`, `resume()`, `exec()` ledger logging, `CommandError`, `computeSetupHash`, `bash()` streaming, and the `when()` predicate context), and flag two fields (`AgentSpec.cliVersion`, `.metadata`, `.registryDependencies`) and one known concurrency limitation (`FlushContext` under `forEach({ concurrency > 1 })`) that are currently no-ops/buggy rather than doing what they were documented to do. No behavior changes — doc-only.
- 3f362d1: Enable npm provenance for published packages.
- Updated dependencies [34cfa8b]
- Updated dependencies [3f362d1]
  - @drej/opensandbox@0.2.1

## 0.5.0

### Minor Changes

- f803858: Agent snapshotting: `Agent.load()` checkpoints the sandbox after Pi install and restores from the snapshot on subsequent loads, reducing startup from ~90s to ~8s. `checkpoint()` now returns the snapshot ID. New `Drej.restoreSnapshot(snapshotId, name, resources)` creates a sandbox from a snapshot without exec replay. `Agent.load()` accepts `{ rebuild: true }` to force reinstall.
- c81c77d: Sandbox API extensions: `pause()` / `resume()`, `createSession()` / `BashSession` persistent shell sessions, `diagnosticLogs()` / `diagnosticEvents()`, `watchMetrics()` streaming, and `Drej.connect()` for attaching to an already-running container. Agent: `Agent.resume(sandboxId)` to reconnect a new host process to a live agent sandbox (restarts the bridge with `--continue`).

### Patch Changes

- Updated dependencies [c81c77d]
  - @drej/opensandbox@0.2.0

## 0.4.0

### Minor Changes

- 2bbd8dc: refactor: pivot drej to sandbox execution substrate

  **`drej`**

  - Remove `client.run()`, `WorkflowRun`, builder API
  - Add `client.sandbox()` returning a live `Sandbox` object; `sandboxId` is the OpenSandbox container ID and ledger key
  - Add `client.resume(sandboxId)` for checkpoint-based replay
  - Add `client.sandboxes.*` for listing and managing sandbox history

  **`@drej/core`**

  - Remove `steps/`, `workflow.ts`, `validate.ts`
  - Add `Sandbox` class with `exec()`, `execCode()`, `writeFile()`, `readFile()`, `checkpoint()`, `close()`, and more
  - Add `ExecHandle` — `PromiseLike<ExecResult>` with `pipe()`, `stdout()`, `result()`; supports streaming and ledger-replay modes
  - Add `SandboxHooks` for observability (`onSandboxCreated`, `onExecStart`, `onExecComplete`, `onCheckpoint`, `onSandboxClosed`, `onSandboxFailed`)
  - New `LedgerEvent` variants: `sandbox_created`, `exec_start`, `exec_event`, `exec_complete`, `checkpoint_created`, `sandbox_closed`
  - Rename `RunStatus` → `SandboxStatus`, `RunDetails` → `SandboxDetails`, `ListRunsOptions` → `ListSandboxOptions`
  - `LedgerEntry` fields: `workflowName` → `name`, `runId` → `sandboxId`

  **`@drej/sqlite` / `@drej/postgres`**

  - Schema: columns `run_id` → `sandbox_id`, `wf_name` → `name`
  - AGG query now derives status from `sandbox_created` / `sandbox_closed` events and counts `exec_complete` for `execCount`
  - `lastCheckpoint()` now queries `checkpoint_created` (was querying the old `checkpoint` event)
  - Adapter methods renamed: `listRunDetails` → `listSandboxDetails`, `listAllRunDetails` → `listAllSandboxDetails`, `getRunDetails` → `getSandboxDetails`, `deleteRun` → `deleteSandbox`

  **`@drej/workflow`**

  - New package: lazy `WorkflowBuilder` with `sandbox()`, `parallel()`, `sequence()`
  - Synchronous `SandboxBuilder` queues `exec`, `checkpoint`, `retry`, `when`, `forEach` ops; flushed at `.pipe()` time

  **`@drej/otel`**

  - Rewrite hooks from workflow-step model to sandbox/exec model (`SandboxHooks`)
  - OTel span attribute `drej.run.id` → `drej.sandbox.id`

### Patch Changes

- 10417e3: feat: add drejx CLI with Docker-based OpenSandbox init and registry support; add useServerProxy option to Drej client
- 416bc72: Remove `SandboxStatus.Failed` and `SandboxStatus.Cancelled` enum values and `SandboxDetails.error` field — these were never derivable from ledger events and could not be produced by any code path.
- Updated dependencies [10417e3]
  - @drej/opensandbox@0.1.4

## 0.3.0

### Minor Changes

- 22b8a32: feat: concurrency limits

  Add `maxConcurrency` to `DrejClientOptions` to cap simultaneous workflow runs — `run()` awaits a slot before starting when at capacity. Add `maxConcurrency` to `parallel` and `loop` StepDefs so branches and loop iterations are throttled via a worker-pool; the `parallel()` and `forEach()` builders expose this as an `opts.concurrency` argument.

- 799b6dd: Add file ops steps and `ref()` builder API

  New step types: `deleteFile`, `moveFile`, `listDirectory`, `searchFiles`.

  `listDirectory` stores `DirectoryEntry[]` in state under the given key; `searchFiles` stores `string[]` which can be passed directly to `forEach`.

  New `ref<T>(name)` function creates a typed state reference. Use it instead of raw `"{{name}}"` strings anywhere the builder accepts a captured value:

  ```ts
  const sha = ref<string>("sha");
  const tsFiles = ref<string[]>("tsFiles");

  workflow("build").sandbox({ image: { uri: "node:20" } }, (s) =>
    s
      .exec("git rev-parse HEAD", { capture: sha })
      .searchFiles("**/*.ts", { as: tsFiles })
      .forEach(tsFiles, (s, file) => s.exec(`tsc ${file}`))
      .exec("deploy.sh", { envs: { GIT_SHA: sha } })
  );
  ```

  `Ref<T>` objects also work naturally in template literals: `` `echo ${sha}` `` expands to `"echo {{sha}}"` at build time.

  Also fixes: `cwd` and `envs` values in `exec()` are now interpolated against workflow state at runtime (previously passed verbatim).

- 8d9d8bb: refactor: split large source files into focused modules

  `@drej/core`: `steps.ts` (428 lines) split into `steps/` directory — `types.ts`, `utils.ts`, `sandbox.ts`, `exec.ts`, `file.ts`, `snapshot.ts`, `control-flow.ts`, `index.ts`. `buildStep` becomes a thin router that delegates to per-step-type builders; no circular dependencies.

  `drej` SDK: `client.ts` split into `types.ts` (DrejError, WorkflowRun, option interfaces) and `stream.ts` (makeStream standalone function). `workflow.ts` split into `builder/` directory — `types.ts`, `sandbox-step.ts`, `workflow.ts`, `index.ts`. No public API changes.

- 2fd33e0: feat: run management API

  Add `RunStatus` enum, `RunDetails` type, and `ListRunsOptions` for filtering. Replace `listRuns()` with `listRunDetails()`, `listAllRunDetails()`, `getRunDetails()`, and `deleteRun()` on both `IStorageAdapter` and `DrejClient`. Add `WorkflowRun.status` property that tracks execution state as events are consumed.

- 0d94c2a: Add per-step timeout and AbortSignal cancellation

  **Per-step timeouts**: steps now accept `timeoutMs` to cap execution time. A
  global fallback can be set via `RunOptions.stepTimeoutMs`. When exceeded, the
  step fails with `StepTimeoutError` and rollback runs automatically.

  **Cancellation**: `WorkflowRun.cancel()` aborts the run immediately. Breaking
  out of the `for await` loop does the same. Pass `RunOptions.signal` to wire in
  an external `AbortController` or `AbortSignal.timeout()`.

  Both features share the same internal mechanism: a per-step `AbortController`
  scoped to both `ControlClient` and `ExecClient` via `withSignal()`, so
  in-flight HTTP calls and SSE exec streams are cancelled cleanly at the fetch
  level. Rollback still runs with unscoped clients to ensure cleanup always
  completes.

### Patch Changes

- Updated dependencies [0d94c2a]
  - @drej/opensandbox@0.1.3

## 0.2.0

### Minor Changes

- 4c0ad93: Add `capture` option to `exec()` for storing stdout in workflow state

  Pass `{ capture: "key" }` to store a command's stdout under that key in
  workflow state. The value is immediately available for interpolation in
  subsequent steps via `{{key}}`, or accessible on `WorkflowState` after
  the run. Trailing newlines are trimmed.

  ```ts
  workflow("deploy").sandbox({ image: { uri: "node:20-slim" } }, (s) =>
    s
      .exec("git rev-parse HEAD", { capture: "sha" })
      .exec("echo deploying commit {{sha}}")
  );
  ```

- a971b7b: Add `s.readFile(path, { as })` step to read sandbox files into workflow state

  File contents are stored under the given key and immediately available for
  interpolation in subsequent steps via `{{key}}`, or accessible on the final
  workflow state after the run. Supports `utf8` (default) and `base64` encoding.

  ```ts
  workflow("build").sandbox({ image: { uri: "node:20-slim" } }, (s) =>
    s
      .exec('node -e "process.version" > /tmp/version.txt')
      .readFile("/tmp/version.txt", { as: "version" })
      .exec("echo Node version: {{version}}")
  );
  ```

- ce173be: Make sandbox lifecycle explicit — no more implicit deletion

  Previously `workflow().sandbox(opts, fn)` automatically deleted the sandbox
  at the end of the workflow and on rollback. Sandbox lifecycle is now the
  caller's responsibility.

  **What changed:**

  - `sandbox()` no longer appends a `delete_sandbox` step or rolls back on failure
  - `sandbox()` now accepts an existing `Sandbox` object in place of `SandboxOpts`,
    letting you pass a sandbox you created and manage yourself
  - Call `client.deleteSandbox(id)` explicitly when you are done with a sandbox

  ```ts
  // Create a fresh sandbox — stays alive after the workflow
  const run = await client.run(
    workflow("build").sandbox({ image: { uri: "node:20-slim" } }, (s) =>
      s.exec("npm ci").exec("npm test"),
    ),
  );
  for await (const ev of run) { ... }
  await client.deleteSandbox(run.sandboxId); // explicit cleanup

  // Or manage the sandbox yourself
  const sb = await client.createSandbox({ image: { uri: "node:20-slim" } });
  await client.run(workflow("build").sandbox(sb, (s) => s.exec("npm test")));
  await client.run(workflow("lint").sandbox(sb, (s) => s.exec("npm run lint")));
  await client.deleteSandbox(sb.id);
  ```

- 86c2dde: Add `s.snapshot()` as a first-class workflow step

  Previously, capturing a sandbox snapshot required passing `snapshotConfig: { afterSteps: [N] }` to `client.run()` — which meant counting step indices upfront and re-counting whenever steps were reordered.

  `s.snapshot()` declares the checkpoint inline, where it belongs:

  ```ts
  workflow("build").sandbox({ image: { uri: "node:20-slim" } }, (s) =>
    s
      .exec("npm ci")
      .snapshot() // checkpoint: deps installed
      .exec("npm test")
  );
  ```

  The snapshot ID is persisted to the ledger and stored in workflow state as `snapshotId`. `client.replayFromSnapshot()` works the same way regardless of which method was used to take the snapshot.

  `snapshotConfig` on `client.run()` remains supported — it is useful when you need to snapshot a workflow you didn't write, or snapshot on a cadence (`everyNSteps`) rather than at a fixed point.

- 82094ae: Add typed workflow errors: `SandboxError`, `ExecConnectionError`, `CommandError`.

  Infra failures (sandbox boot failure, execd connection timeout) now throw typed errors instead of generic `Error`. Add `strict` option to `exec()` — when enabled, a non-zero exit code throws `CommandError` with the exit code attached. Errors propagate through the `WorkflowRun` async iterator so callers can catch them with a standard `try/catch` around the `for await` loop. All failures continue to be recorded in the ledger via `LedgerEvent.StepFailed`.

### Patch Changes

- b04f8eb: Add `execCode()` to the workflow builder and expose exit code in workflow state.

  `SandboxStepBuilder.execCode()` lets you run code directly (Python, Node.js, etc.)
  via execd's code interpreter — with optional stateful context to share variables
  across calls. Previously only shell commands (`exec()`) were available in the builder.

  `exec()` now captures the command exit code from the SSE stream and sets
  `exitCode` on workflow state after each step. This makes `when({ field: "exitCode" })`
  predicates actually useful for branching on command success or failure.

  `CodeContext` is now exported from the `drej` package for consumers who want to
  type context options explicitly.

- Updated dependencies [b04f8eb]
  - @drej/opensandbox@0.1.2

## 0.1.1

### Patch Changes

- 0ea4c33: Rename npm scope from `@drej/*` to `@drej/*` and add TSDoc to all public API surfaces.

  - All workspace packages now published under `@drej/*` (e.g. `@drej/sqlite`, `@drej/postgres`)
  - `DrejClient`, `WorkflowBuilder`, `SandboxStepBuilder`, `IStorageAdapter`, `LedgerEvent`, `SandboxOpts` and all their members now have hover documentation visible in VS Code

- Updated dependencies [0ea4c33]
  - @drej/opensandbox@0.1.1

## 0.1.0

### Minor Changes

- 82e77fd: Introduce pluggable storage adapter system.

  - `ILedger` renamed to `IStorageAdapter` with optional `connect()` and `close()` lifecycle methods
  - `DrejClientOptions.adapter` accepts any `IStorageAdapter` implementation; `DrejClient` exposes matching `connect()` and `close()` methods
  - New `@drej/postgres` package: `PostgresAdapter` backed by a user-supplied Postgres connection string; owns its schema and runs migrations on `connect()`

- 5d77498: Bundle SDK, publish workspace packages publicly, and make adapter required.

  - `@drej/core` and `@drej/opensandbox` are now published public packages (previously private workspace-only)
  - `drej` SDK ships a pre-built `dist/` with a bundled ESM JS file and TypeScript declarations; `"main"` now points to `./dist/index.js`
  - `WorkflowDeps.ledger` field renamed to `WorkflowDeps.adapter`
  - `DrejClientOptions.adapter` is now **required** — callers must supply a storage adapter (`@drej/sqlite`, `@drej/postgres`, or a custom `IStorageAdapter`)
  - `MemoryAdapter`, `NdjsonAdapter`, and the `ledgerDir` shorthand have been removed; drej has no built-in storage opinion
  - Root `build` script added: generates declarations for workspace packages then runs tsup for the SDK

### Patch Changes

- Updated dependencies [5d77498]
  - @drej/opensandbox@0.1.0

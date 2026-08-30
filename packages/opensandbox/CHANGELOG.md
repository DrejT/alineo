# @drej/opensandbox

## 0.2.0

### Minor Changes

- f987d00: Credential injection: sandboxes can now register credentials that get injected into outbound
  requests via OpenSandbox's Credential Vault, without the sandbox process ever holding the real
  value.

  - New `@alineo-labs/vault` package — `OpenSandboxCredentialBroker`, the default `CredentialBroker`
    implementation, wired up automatically by `@alineo-labs/sandbox` unless overridden.
  - `@alineo-labs/core`: new `CredentialBroker`/`CredentialBinding`/`CredentialSource` interfaces
    (mirrors `IStorageAdapter`'s shape), `sb.credentials.set()/patch()/remove()/listBindings()` on
    `SandboxHandle`, `SandboxHooks.onCredentialInjected`, and two new `LedgerEvent`s
    (`CredentialBound`/`CredentialRevoked`, binding metadata only — never the credential value).
    `CredentialSource` (`{ type: "env", varName }` vs. `{ type: "external" }`) lets `resume()` and
    `sb.fork()` resolve env-backed credentials automatically; anything else requires an explicit
    `resolveCredential` callback, and both now **throw** rather than silently drop a bound
    credential if one isn't resolvable.
  - `@alineo-labs/opensandbox`: `NetworkPolicy`/`NetworkRule`/`CredentialProxyConfig` types, and
    `networkPolicy`/`credentialProxy` on `CreateSandboxOptions`.
  - `@alineo-labs/sandbox`: `SandboxOptions.networkPolicy`/`credentialProxy`,
    `SandboxClientOptions.credentialBroker`, and `ResumeOptions.resolveCredential`. `sb.fork()`
    now also carries over the parent's own bound credentials to the child automatically (previously
    silently dropped), and takes an optional `{ resolveCredential, credentialProxy }`.
  - `alineo` (agent package): `AgentSpec.env` values can now be a `CredentialEnvBinding`
    (`{ credential, host, injection }`) instead of a plain string — that key never becomes a
    container env var at all; `Alineo.load()`/`.resume()`/`.spawn()` register it with the broker
    instead (including for a spawned child's own newly-declared bindings, previously dropped).
  - `alineo-cli`: `alineo init` now configures `[egress]` (`opensandbox/egress:v1.1.7`,
    `mode = "dns+nft"`) in the generated local server config by default — inert for any sandbox
    that doesn't request `networkPolicy`, but required before `credentialProxy: true` works at all
    against a fresh `alineo init` server.

  See `plans/credential-injection.md` for the full design (issue #203). Verified end-to-end against
  a live `opensandbox/server:latest` + `opensandbox/egress:v1.1.7`: registration, transparent
  injection, revocation, and `fork()` credential carrying. Two known limitations, both from the
  real Credential Vault API rather than this package: only `{ type: "header" }` credential bindings
  are supported for now (`query`/`path` injection has no direct equivalent in the sidecar's `Auth`
  model), and `OpenSandboxCredentialBroker.patch()` requires both `value` and `binding` together
  (the vault never echoes a credential's value back, so a partial update can't preserve the
  unspecified half).

### Patch Changes

- 84b7862: Internal: enabled Oxlint's type-aware linting repo-wide and fixed every finding it surfaced
  (681 → 0). Almost entirely non-behavioral (removing unnecessary type assertions, replacing
  non-null assertions with real invariant checks, fixing tsconfig gaps that were masking latent
  type errors) — flagged the couple of exceptions below since they do change observable behavior.

  - `alineo-cli`'s Pi bootstrap extension (`pi-extension/alineo.ts`) no longer replaces an
    empty-but-present `stderr` string with a generic fallback message in its install/init failure
    notifications — only a genuinely missing `stderr` falls back now.
  - `@alineo-labs/core`'s `SandboxCore` gained a couple of small correctness fixes surfaced along the
    way: `bun:sqlite`'s deprecated `exec()` alias replaced with `run()`, and a `finally`-block cleanup
    path in a test that could previously mask a real assertion failure with an unrelated error now
    logs instead of throwing.
  - `packages/cli/src/tui/chat.ts`'s `AgentEvent` switch now lists all 14 previously-implicit
    "ignored" event kinds explicitly instead of a bare `default`, so a future new event kind fails
    exhaustiveness and forces a conscious decision, rather than silently landing in "ignored".

  No public API changes. Full `typecheck`/`test`/`build` suite passes for every package.

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
- bd95393: Remove `private: true` from the 10 publishable packages so they can actually be published to
  npm. No functional or API changes — this is the last step of npm-publish readiness (repository
  URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.

## 0.3.1

### Patch Changes

- cc5059a: Cancel the exec/code SSE stream as soon as the terminal event (`execution_complete` or `error`) arrives instead of reading until the server closes the connection. execd holds the HTTP stream open for a fixed interval after sending its last event, so every `exec()`/`execCode()`/session command was paying that delay on top of the real round trip — this cuts steady-state exec latency from roughly 1 second to tens of milliseconds.

  Also switch the fixed-interval polling in `waitForRunning`, `waitForSnapshot`, and `resolveExecClient` to start fast and back off toward the original interval, instead of sleeping the full interval on every tick regardless of how quickly the real state change lands. Measured against a local OpenSandbox server, this cut checkpoint latency from ~2s to ~300-500ms.

## 0.3.0

### Minor Changes

- fa18120: Add `sb.exec(cmd, { interactive: true })` for live, bidirectional PTY sessions — human-in-the-loop CLI access inside a sandbox. Returns an `InteractiveExecHandle` with `write()`, `resize()`, `signal()`, `close()`, and `attach()` in addition to the usual `stdout()`/`pipe()`/`result()`/`await` surface.

  Every `write()` is logged to the ledger alongside output, so a session still open at the last checkpoint is reconstructed on resume by replaying its recorded stdin for real against the freshly restored filesystem (OpenSandbox snapshots are rootfs-only — the original process is gone after resume, so this is the only way to re-derive shell state like exported vars or `cd`s).

  `@drej/opensandbox` gains a `PtyClient` wrapping execd's `/pty` REST + WebSocket protocol.

### Patch Changes

- b2d7096: Fix `ControlClient.listSandboxes()` and `listSnapshots()` returning the raw `{ items: [...] }` pagination envelope instead of a bare array — the declared return type was `Sandbox[]`/`Snapshot[]` but the methods never unwrapped `.items`, so `result.length` was `undefined` and array methods threw. Neither method had a caller anywhere else in the codebase, so this was previously untested dead code; surfaced by `examples/pi-agent/test-spawn-child.ts`, which uses `listSandboxes()` directly against the live OpenSandbox API.

## 0.2.3

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

## 0.2.2

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

## 0.2.1

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- 3f362d1: Enable npm provenance for published packages.

## 0.2.0

### Minor Changes

- c81c77d: Sandbox API extensions: `pause()` / `resume()`, `createSession()` / `BashSession` persistent shell sessions, `diagnosticLogs()` / `diagnosticEvents()`, `watchMetrics()` streaming, and `Drej.connect()` for attaching to an already-running container. Agent: `Agent.resume(sandboxId)` to reconnect a new host process to a live agent sandbox (restarts the bridge with `--continue`).

## 0.1.4

### Patch Changes

- 10417e3: feat: add drejx CLI with Docker-based OpenSandbox init and registry support; add useServerProxy option to Drej client

## 0.1.3

### Patch Changes

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

## 0.1.2

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

## 0.1.1

### Patch Changes

- 0ea4c33: Rename npm scope from `@drej/*` to `@drej/*` and add TSDoc to all public API surfaces.

  - All workspace packages now published under `@drej/*` (e.g. `@drej/sqlite`, `@drej/postgres`)
  - `DrejClient`, `WorkflowBuilder`, `SandboxStepBuilder`, `IStorageAdapter`, `LedgerEvent`, `SandboxOpts` and all their members now have hover documentation visible in VS Code

## 0.1.0

### Minor Changes

- 5d77498: Bundle SDK, publish workspace packages publicly, and make adapter required.

  - `@drej/core` and `@drej/opensandbox` are now published public packages (previously private workspace-only)
  - `drej` SDK ships a pre-built `dist/` with a bundled ESM JS file and TypeScript declarations; `"main"` now points to `./dist/index.js`
  - `WorkflowDeps.ledger` field renamed to `WorkflowDeps.adapter`
  - `DrejClientOptions.adapter` is now **required** — callers must supply a storage adapter (`@drej/sqlite`, `@drej/postgres`, or a custom `IStorageAdapter`)
  - `MemoryAdapter`, `NdjsonAdapter`, and the `ledgerDir` shorthand have been removed; drej has no built-in storage opinion
  - Root `build` script added: generates declarations for workspace packages then runs tsup for the SDK

# @drej/sqlite

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

- bd95393: Remove `private: true` from the 10 publishable packages so they can actually be published to
  npm. No functional or API changes — this is the last step of npm-publish readiness (repository
  URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.
- Updated dependencies [a9564e1]
- Updated dependencies [b03ae19]
- Updated dependencies [7acdf32]
- Updated dependencies [bd95393]
- Updated dependencies [2a61e0c]
- Updated dependencies [637b678]
- Updated dependencies [acc51e3]
  - @alineo-labs/core@1.0.0

## 0.3.8

### Patch Changes

- Updated dependencies [cc5059a]
  - @drej/core@0.6.3

## 0.3.7

### Patch Changes

- Updated dependencies [5a01e36]
  - @drej/core@0.6.2

## 0.3.6

### Patch Changes

- Updated dependencies [e343eab]
  - @drej/core@0.6.1

## 0.3.5

### Patch Changes

- Updated dependencies [fa18120]
  - @drej/core@0.6.0

## 0.3.4

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

- Updated dependencies [a4856f1]
  - @drej/core@0.5.3

## 0.3.3

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

- Updated dependencies [a91651c]
  - @drej/core@0.5.2

## 0.3.2

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- 3f362d1: Enable npm provenance for published packages.
- Updated dependencies [34cfa8b]
- Updated dependencies [bca2a6b]
- Updated dependencies [3f362d1]
  - @drej/core@0.5.1

## 0.3.1

### Patch Changes

- a0c1eee: Add README to each published package so npm shows documentation on the package page.
- Updated dependencies [f803858]
- Updated dependencies [c81c77d]
  - @drej/core@0.5.0

## 0.3.0

### Minor Changes

- 5a63143: Add named checkpoints: `sb.listCheckpoints()` returns all checkpoints in creation order with `snapshotId`, `tag`, and `createdAt`. `client.resume(id, { tag })` resumes from a specific named checkpoint instead of the most recent. New exported types: `CheckpointInfo`, `ResumeOptions`. Storage adapters gain `listCheckpoints()`.
- 2ed4de7: Add sandbox environments: define a named environment with a setup recipe, build it once into a snapshot, and spawn cheap isolated sandboxes from it on demand. New API: `client.environment(name, opts)` returns an `Environment` with `.sandbox()`, `.rebuild()`, and `.info()`. `client.environments.list/delete` manage cached records. Storage adapters gain `getEnvironment`, `saveEnvironment`, `deleteEnvironment`, `listEnvironments`.
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

- Updated dependencies [10417e3]
- Updated dependencies [416bc72]
- Updated dependencies [2bbd8dc]
  - @drej/core@0.4.0

## 0.2.0

### Minor Changes

- 2fd33e0: feat: run management API

  Add `RunStatus` enum, `RunDetails` type, and `ListRunsOptions` for filtering. Replace `listRuns()` with `listRunDetails()`, `listAllRunDetails()`, `getRunDetails()`, and `deleteRun()` on both `IStorageAdapter` and `DrejClient`. Add `WorkflowRun.status` property that tracks execution state as events are consumed.

### Patch Changes

- Updated dependencies [22b8a32]
- Updated dependencies [799b6dd]
- Updated dependencies [8d9d8bb]
- Updated dependencies [2fd33e0]
- Updated dependencies [0d94c2a]
  - @drej/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [4c0ad93]
- Updated dependencies [b04f8eb]
- Updated dependencies [a971b7b]
- Updated dependencies [ce173be]
- Updated dependencies [86c2dde]
- Updated dependencies [82094ae]
  - @drej/core@0.2.0

## 0.1.1

### Patch Changes

- 0ea4c33: Rename npm scope from `@drej/*` to `@drej/*` and add TSDoc to all public API surfaces.

  - All workspace packages now published under `@drej/*` (e.g. `@drej/sqlite`, `@drej/postgres`)
  - `DrejClient`, `WorkflowBuilder`, `SandboxStepBuilder`, `IStorageAdapter`, `LedgerEvent`, `SandboxOpts` and all their members now have hover documentation visible in VS Code

- Updated dependencies [0ea4c33]
  - @drej/core@0.1.1

## 0.1.0

### Minor Changes

- 5d77498: Introduce `@drej/sqlite` storage adapter.

  `SQLiteAdapter` implements `IStorageAdapter` via Bun's built-in `bun:sqlite` — zero extra dependencies and no infrastructure required. Data persists across restarts, making it suitable for local development and single-process production workloads.

  ```ts
  import { DrejClient } from "drej";
  import { SQLiteAdapter } from "@drej/sqlite";

  const client = new DrejClient({
    baseUrl: "http://localhost:8080",
    adapter: new SQLiteAdapter("./drej.db"),
  });
  await client.connect();
  ```

  WAL mode is enabled on `connect()` for safe concurrent reads alongside ongoing writes.

### Patch Changes

- Updated dependencies [82e77fd]
- Updated dependencies [5d77498]
  - @drej/core@0.1.0

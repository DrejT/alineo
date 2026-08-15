# drejx

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

- 425d9bc: Add anonymous CLI usage telemetry: which subcommand ran, a small per-command allowlist of
  boolean flag presence (never values or raw argv), success/failure, timing, and — for
  `spawn`/`fork` only — the target spec's own `provider` id. Default-off for this release (no
  production endpoint deployed yet — flips on once one is), opt-out via
  `alineo telemetry disable`/`status`/`enable` or the `ALINEO_TELEMETRY_DISABLED`/`DO_NOT_TRACK`
  env vars either way. Transport is a plain, bounded (500ms timeout) `fetch()` POST to a new,
  completely standalone ingest app, `apps/telemetry` — no OpenTelemetry, no dependency on any
  other app in this repo, in either direction. Server-side re-validates every event against the
  same allowlisted shape (never trusts the client), with a body-size cap and a per-anonymous-ID
  rate limit on its one unauthenticated route.
- f7c04f7: Point CLI telemetry at the deployed ingest endpoint (`https://telemetry.alineo.tech`) and flip
  the default from off to on, now that the endpoint is actually live. Opt out any time with
  `alineo telemetry disable`, `ALINEO_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`. See
  `alineo telemetry` in the docs for exactly what's collected.
- 637b678: Add `runId` — a first-class way to correlate sandboxes belonging to the same logical run, surfaced through `SandboxDetails.runId` and filterable via `client.sandboxes.list({ runId })`/`listByName({ runId })`.

  - `SandboxOptions.runId` (optional, defaults to a fresh `crypto.randomUUID()` if omitted) is recorded on every sandbox-creation path (`client.sandbox()`, `client.resume()`, `client.restoreSnapshot()`, `sb.fork()`, environment-backed sandboxes) — a resumed, restored, or forked sandbox always inherits its origin's `runId` rather than getting a new one.
  - `sb.fork(tag?, runId?)` gains an optional explicit override, needed across a process boundary (e.g. `alineo fork`, which re-`Agent.attach()`es in a brand-new CLI process with no access to the original in-memory closure) — same reasoning `ALINEO_SPAWN_DEPTH` already established, generalized to run identity.
  - `Agent.load()`/`Agent.resume()` accept an optional `runId`, bake `ALINEO_RUN_ID` into the sandbox's env alongside `ALINEO_SPAWN_DEPTH`/`ALINEO_MAX_AGENTS`/`ALINEO_OBSERVABILITY`, and expose it as `agent.runId`. `Agent.spawn()`/`alineo fork` force-inherit it into every forked child, tamper-resistant like the existing budget fields. `alineo spawn` gains a `--run-id` flag.
  - `runId` also rides along in `SandboxOptions.metadata`/`CreateSandboxOptions.metadata` at every creation path, since the ledger alone can't correlate sandboxes across separate adapter instances (e.g. a forked child writing to its own in-container ledger file) — the OpenSandbox control plane is the one channel every caller shares regardless of adapter, and its `Sandbox` type already declares (and, verified against a live server, actually echoes back) `metadata`.
  - Both storage adapters (`@alineo-labs/sqlite`, `@alineo-labs/postgres`) extend their aggregation query to surface `runId` on `SandboxDetails` and support it as a `ListSandboxOptions` filter — no schema migration needed, read out of the existing JSON payload.

### Patch Changes

- 9fb6550: Document the alineo telemetry command in packages/cli/README.md and the docs site. No behavior change.
- 735ecf7: `alineo fork`/`spawn`/`prompt` now accept `--timeout SECONDS` to bound how long a `--prompt`
  waits for activity before failing with a clear error, instead of hanging forever if the
  underlying agent process ever goes silent. `--json` output also now includes `toolCalls`
  alongside `reply`, so a turn that made tool calls but produced no final text is distinguishable
  from one that did nothing.
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
- 94dfc3d: Remove `pi-extension/alineo.ts`'s typed `alineo_spawn`/`alineo_prompt`/`alineo_agents`/`alineo_kill`
  tools. They sat next to `alineo fork` — deliberately never a typed tool, since forking is a
  judgment call about task decomposition that belongs in a real shell command — and that
  asymmetry measurably steered models toward the wrong primitive (issue #21 Bug B: a run picked
  the typed `alineo_spawn` tool over the `alineo fork` shell command the guidance text recommended
  for that exact scenario). All five subcommands are bash-only now, guided by the same prose
  guidance the extension already injected. The extension itself stays in place, deprecated,
  for its remaining `before_agent_start` guidance injection and `ensureAlineoReady()` bootstrap.
- acc51e3: Update package.json repository fields to the renamed GitHub repo (DrejT/drej -> DrejT/alineo). No behavior change.
- Updated dependencies [b03ae19]
- Updated dependencies [e1f6621]
- Updated dependencies [bd95393]
- Updated dependencies [735ecf7]
- Updated dependencies [2a61e0c]
- Updated dependencies [637b678]
- Updated dependencies [acc51e3]
  - @alineo-labs/opensandbox@1.0.0
  - @alineo-labs/agent@1.0.0
  - @alineo-labs/sqlite@1.0.0
  - alineo@1.0.0

## 0.7.2

### Patch Changes

- Updated dependencies [cc5059a]
  - @drej/opensandbox@0.3.1
  - drej@0.10.4
  - @drej/sqlite@0.3.8
  - @drej/agent@0.6.2

## 0.7.1

### Patch Changes

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
- Updated dependencies [5a01e36]
  - @drej/agent@0.6.1
  - drej@0.10.3
  - @drej/sqlite@0.3.7

## 0.7.0

### Minor Changes

- 7bd8e5d: Renamed CLI commands: `drejx run` → `drejx spawn` (start a fresh, independent agent sandbox from a spec), and the previous `drejx spawn` (fork a running session's own live sandbox into a child) → `drejx fork`. "Spawn" now consistently means "create," matching how it reads; "fork" now names the operation that actually forks live state, matching `Agent.spawn()`'s own doc language.

  Renamed `--spawn-depth` to `--depth` on `spawn`/`fork` (POSIX-style, and paired now with the new `--max` flag below).

  Added a `--max` flag (and matching `maxAgents` spec field) — a separate, optional ceiling on total descendants for a lineage, distinct from `--depth`'s nesting-depth limit. Unset means uncapped for this dimension; `--depth` alone still gates whether spawning/forking is allowed at all. Enforced per-lineage only — sibling branches forked in parallel don't share or coordinate this budget with each other. Implemented the same tamper-resistant env-counter pattern as `spawnDepth`/`DREJX_SPAWN_DEPTH`, via a new `DREJX_MAX_AGENTS` env var.

  `drejx prompt`/`drejx kill`'s `--spec`-adjacent internals and the Pi extension's `drejx_run` tool are updated to `drejx_spawn` to match the rename.

  `drejx agents` now cross-checks the ledger's "Running" sandboxes against the live OpenSandbox control plane before listing them — a sandbox that died ungracefully (crashed, expired via OpenSandbox's own TTL, deleted outside drej) previously stayed listed as "Running" forever, since nothing ever told the ledger otherwise.

- 6e6fbfa: Adds `drejx --version`/`-v`/`version`.

  `packages/cli/package.json` now declares a `"pi": { "extensions": [...] }` manifest, so `pi install npm:drejx` resolves `pi-extension/drejx.ts` as the extension entry point (Pi's own package manager reads this field — see `resolveExtensionEntries()` in `@earendil-works/pi-coding-agent`'s `package-manager.js`). This is the intended host-level install path: `pi install npm:drejx` puts the extension at Pi's user/global scope, available in every session afterward, rather than the project-local copy `examples/rlm-repo-fanout` still uses today.

  The Pi extension itself (`packages/cli/pi-extension/drejx.ts`) gained:

  - A `session_start` handler that bootstraps `drejx` (installs it via npm, runs `drejx init`) so a user never has to do either step manually — this extension is meant to be the whole distribution/setup path, not just a tool-wrapper.
  - A `before_agent_start` handler that injects `drejx` CLI usage guidance into the system prompt every turn — different guidance depending on whether the current session is itself running inside a drej-managed sandbox (`DREJ_SANDBOX_ID` set, so `drejx fork` is meaningful) or is a host-level session (only `drejx spawn` makes sense). Deliberately dynamic per-turn rather than a static prompt blob baked into one spec.
  - An opt-in RLM-orchestrator mindset prompt, gated on a spec setting `DREJX_RLM_MASTER` in its own `env` (so ordinary one-off coding sessions aren't told "you are an orchestrator" unconditionally), with `DREJX_RLM_SYSTEM_PROMPT` as a full override for specs wanting their own wording.

  Adds `examples/rlm-master` — a reusable, non-task-specific RLM master spec, in contrast to `examples/rlm-repo-fanout`'s README-backfill-specific one.

### Patch Changes

- e343eab: Internal restructure: replace the hand-maintained `switch` + separately
  hand-written help-text string in `packages/cli/src/index.ts` with a command
  registry (`packages/cli/src/commands/{types,args,registry}.ts`). Each
  command file now exports its own `xCommand: CliCommand` (argv parsing,
  usage, and summary colocated with its logic), and `index.ts` dispatches and
  generates help text from a single `commands` list — a rename or flag change
  can no longer leave the help text saying something different from what the
  command actually does, which happened at least once this session.

  `registry.ts` keeps command metadata (name/group/usage/summary) as plain
  data with a `run` that dynamically imports each command's implementation
  only when invoked, preserving the original per-command lazy-loaded chunks —
  an earlier version of this change statically imported every command
  up front, which measured ~3x slower for something as trivial as
  `drejx --version` (every command's own dependencies, e.g. `@drej/agent`,
  loading eagerly on every invocation). Verified no regression after the fix.

  No behavior change to any command's flags, argument order, or output.
  Generated help text matches the old hand-written version's content (column
  widths are now computed per-section instead of hand-tuned).

  Part of the codebase restructure plan (plans/codebase-restructure.md,
  Phase 5).

- 7bd8e5d: `drejx prompt` and `drejx kill` now take a sandbox ID instead of a session name. Session names aren't unique — running `drejx run` twice on the same spec produces two sandboxes with the same name — and a name-based lookup could hand back a sandbox that already died ungracefully (crashed before its `close()` ran, expired via OpenSandbox's own TTL), since nothing tells the ledger it stopped. Addressing by sandbox ID removes the ledger detour entirely; the live control-plane check inside `connect()`/`resume()` is the only check, not a second opinion after an already-stale one.

  `drejx prompt` also gains `--spec <path>` to skip its own ledger lookup for the spec file, needed when prompting a sandbox whose `sandbox_created` event lives in a different ledger than the CLI's own (e.g. a child spawned via `drejx spawn` from inside another sandbox).

  The Pi extension (`pi-extension/drejx.ts`)'s `drejx_prompt`/`drejx_kill` tools are updated to match.

- e78be8b: Fix `drejx spawn` when run from inside its own sandbox (the actual `Agent.spawn()` use case): it previously looked up the caller's own running session by name in the local ledger, but a session created via `Agent.load()` from a host process has its `sandbox_created` event recorded in a different `IStorageAdapter` than whatever `drejx spawn` opens from `drej.config.json` inside the container — two independent SQLite files that can never see each other. `drejx spawn` now resolves its own sandbox ID from `DREJ_SANDBOX_ID`, an env var every agent-creation path (`Agent.load()`, `Agent.resume()`, `Agent.spawn()`) now writes to `/etc/drej-env`, falling back to the old ledger lookup only when that's unset.

  Also fixes `Agent.attach()` throwing "Unable to connect" on this same self-attach path: it read `/etc/drej-env` via a network exec call to the sandbox's own externally-facing endpoint, which Docker's default bridge network can't hairpin a container back to itself through. When the target sandbox ID matches this process's own `DREJ_SANDBOX_ID`, it now reads the file from the local filesystem directly instead.

- Updated dependencies [7bd8e5d]
- Updated dependencies [e343eab]
- Updated dependencies [e78be8b]
- Updated dependencies [e78be8b]
- Updated dependencies [e78be8b]
- Updated dependencies [e343eab]
  - @drej/agent@0.6.0
  - @drej/sqlite@0.3.6
  - drej@0.10.2

## 0.6.0

### Minor Changes

- dd89d67: Add `Agent.spawn()`: fork a running agent's live sandbox — filesystem, installed packages, checked-out state — into an independent child running its own Pi bridge, instead of always starting a child from a spec's own snapshot. Exposed via `drejx spawn <name> <child-spec> [--prompt] [--spawn-depth N] [--json]`.

  - `AgentSpec` gains an optional `spawnDepth` field, translated by `Agent.load()`/`Agent.resume()` into `DREJX_SPAWN_DEPTH`. `Agent.spawn()` refuses unless this is a positive integer, and force-computes `depth - 1` into the child regardless of what the child's own spec says — a tamper-resistant counter, not something a spec author or the model can hand-propagate incorrectly.
  - The child's environment is resolved fresh from its own spec, then every name the parent's own env declares is explicitly `unset` in the exact shell command that starts the child's bridge — verified live that `sb.fork()`'s forked container otherwise carries the parent's env vars forward regardless of what's written to `/etc/drej-env`.
  - `Agent.attach()`: connects to a running sandbox without touching its Pi bridge, unlike `resume()` — needed because `drejx spawn` runs as a CLI process invoked by the very Pi bash-tool call it's attaching to; going through `resume()` there would kill the bridge running the process making the call.
  - Fixes two pre-existing gaps in `drej`'s `client.restoreSnapshot()` and `client.connect()`, found while building this: neither wired up the `fork` dependency on the `Sandbox` it returned, so `.fork()` (and now `Agent.spawn()`) would throw "fork() is not supported on this sandbox" for any agent loaded from its snapshot fast path, or attached to via `Agent.attach()`. `client.connect()` now accepts an optional `resources` param to enable this.

### Patch Changes

- Updated dependencies [dd89d67]
  - drej@0.10.1
  - @drej/agent@0.5.0

## 0.5.0

### Minor Changes

- 4cfe868: Restructure `drejx` into three clean layers per `plans/drejx-layers.md`:

  - **CLI**: renamed `ps` → `agents`, removed the interactive `attach` REPL, added
    `drejx prompt <name> <message>` (send one message to a running session, get the
    reply, no terminal needed), and `--json` on `run`/`prompt`/`agents`/`logs` for
    machine-readable output. `run` no longer attaches interactively — it starts a
    session, optionally sends a first prompt via `--prompt`, and exits.
  - **TUI**: bare `drejx` now includes a new-session launcher (browse local specs +
    the registry.drej.dev catalog, pick one, it fetches and runs) and a logs view,
    alongside the existing dashboard and chat view. The dashboard also gains a
    `k` kill action.
  - **Pi extension**: `packages/cli/pi-extension/drejx.ts`, shipped with the npm
    package, registers `drejx_run`/`drejx_prompt`/`drejx_agents`/`drejx_kill` as
    typed Pi tools — lets a Pi agent orchestrate child drejx sessions without
    hand-rolling `osb` bash commands.

  Breaking CLI changes (`ps` renamed, `attach` removed) — low-stakes since `drejx`
  has no meaningful external adoption yet.

## 0.4.0

### Minor Changes

- 9181b8e: Add tmux-style session commands: `drejx run <spec> [--detach] [--rebuild]`, `drejx ps`, `drejx attach <name>`, `drejx kill <name>`, `drejx logs <name>`. Bare `drejx` in a terminal now launches an interactive TUI (built on `@opentui/core`) with a dashboard of running sessions and a chat view. Existing `init`/`add`/`list`/`remove` commands are unchanged.

## 0.3.0

### Minor Changes

- 2adcea6: Add tmux-style session commands: `drejx run <spec> [--detach] [--rebuild]`, `drejx ps`, `drejx attach <name>`, `drejx kill <name>`, `drejx logs <name>`. Bare `drejx` in a terminal now launches an interactive TUI (built on `@opentui/core`) with a dashboard of running sessions and a chat view. Existing `init`/`add`/`list`/`remove` commands are unchanged.

### Patch Changes

- Updated dependencies [b7aaa2f]
- Updated dependencies [5055755]
- Updated dependencies [9cc6b08]
- Updated dependencies [13b826b]
- Updated dependencies [fa18120]
- Updated dependencies [b2d7096]
  - @drej/agent@0.4.0
  - drej@0.10.0
  - @drej/opensandbox@0.3.0
  - @drej/sqlite@0.3.5

## 0.2.4

### Patch Changes

- a4856f1: Fix every published package that depends on a sibling workspace package shipping a literal `"workspace:*"` version string instead of a real semver range.

  `changeset publish` always shells out to plain `npm publish`, which has no concept of the `workspace:` protocol — unlike `bun publish`/`pnpm publish`, which resolve it automatically. Every currently published version of `drej`, `@drej/agent`, `@drej/workflow`, and `drejx` has `"workspace:*"` in its `dependencies`, which `npm install` cannot resolve at all (`EUNSUPPORTEDPROTOCOL`). Installing any of these packages from npm fails outright.

  Added `scripts/resolve-workspace-protocol.ts`, run in CI immediately before `npm publish`, which rewrites every `workspace:*`/`workspace:^`/`workspace:~` dependency range to the corresponding package's already-resolved version before the tarball is packed.

- Updated dependencies [a4856f1]
  - drej@0.9.3
  - @drej/sqlite@0.3.4
  - @drej/agent@0.3.2

## 0.2.3

### Patch Changes

- a91651c: Fix npm publish failures and a broken `drejx` CLI build:

  - Add the missing `repository` field to every published package's `package.json`. Without it, npm rejects publishes with `provenance: true` enabled (added previously) — every package failed to publish with a 422 "Error verifying sigstore provenance bundle" (see the last "Version Packages" release run).
  - Add `packages/cli` to the root `build` script. It was never built by CI before publish, so every previously-published `drejx` version (up to and including 0.2.1 on npm) shipped with no `dist/` folder at all — the CLI has never actually worked when installed from npm.
  - Remove a duplicate shebang in `packages/cli/tsdown.config.ts`'s `banner` config (the source file already has its own `#!/usr/bin/env bun`), which produced a syntactically broken `dist/index.mjs` whenever the package _was_ built manually.
  - Add `packages/agent` and `packages/cli` to the root `typecheck` script — both were previously only checked ad hoc.

- Updated dependencies [a91651c]
  - drej@0.9.2
  - @drej/sqlite@0.3.3
  - @drej/agent@0.3.1

## 0.2.2

### Patch Changes

- 34cfa8b: Add the missing `license` field (Apache-2.0) to every published package's `package.json`, matching the repo's root `LICENSE` file.
- 3f362d1: Enable npm provenance for published packages.
- Updated dependencies [34cfa8b]
- Updated dependencies [fdc25db]
- Updated dependencies [cf9af70]
- Updated dependencies [bca2a6b]
- Updated dependencies [7fb9d35]
- Updated dependencies [3f362d1]
  - drej@0.9.1
  - @drej/sqlite@0.3.2
  - @drej/agent@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [a0c1eee]
- Updated dependencies [f803858]
- Updated dependencies [3f55f48]
- Updated dependencies [e9a9110]
- Updated dependencies [b773030]
- Updated dependencies [c81c77d]
  - drej@0.9.0
  - @drej/agent@0.2.0
  - @drej/sqlite@0.3.1

## 0.2.0

### Minor Changes

- 10417e3: feat: add drejx CLI with Docker-based OpenSandbox init and registry support; add useServerProxy option to Drej client

### Patch Changes

- Updated dependencies [2c2eb16]
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
  - @drej/agent@0.1.1
  - drej@0.8.0
  - @drej/sqlite@0.3.0

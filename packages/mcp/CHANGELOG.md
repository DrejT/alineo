# alineo-mcp

## 0.3.0

### Minor Changes

- a5bd004: **BREAKING:** `AgentSpec.cli` → `AgentSpec.harness`, `cliVersion` → `harnessVersion`.

  ```diff
  -{ "name": "my-agent", "cli": "pi", "cliVersion": "1.2.3", "model": "…" }
  +{ "name": "my-agent", "harness": "pi", "harnessVersion": "1.2.3", "model": "…" }
  ```

  `cli: "pi"` said the agent-loop driver _is_ a CLI. True of Pi, accidental in general — Claude
  Code, Codex and opencode are the next drivers, and `cli: "claude-code"` would read as a category
  error the day one ships. Renaming now costs one field; renaming after three drivers ship costs a
  migration and a docs rewrite.

  There is no alias, but a spec that still uses `cli` gets told so by name rather than
  "must have a 'harness' field":

  ```
  ✖ Agent spec must have a 'harness' field. Supported values: pi

  This spec uses 'cli' and 'cliVersion', renamed to 'harness' and 'harnessVersion':
  the field names the agent-loop driver, which is not always a CLI.
  ```

  **Your cached snapshots survive.** `computeSetupHash()` deliberately keeps the old key names in
  the object it hashes — it is a cache key nobody reads, and changing the spelling would have
  invalidated every existing snapshot, turning a field rename into a ~90s rebuild of every agent.

  `alineo list` now heads that column `HARNESS`, and `alineo-mcp`'s `SpecSummary.cli` is
  `SpecSummary.harness`. The published JSON Schema at `registry.alineo.tech/spec/agent.json`
  requires `harness`, so an editor validating an old spec against `$schema` will flag it.

  Unchanged: telemetry's own `cliVersion`, which is the version of the alineo CLI itself — a
  different field that happens to share a name.

- 81f809e: **BREAKING:** alineod's event names are namespaced. `agent_spawned` → `agent.spawned`,
  `run_started` → `run.started`, `handle_settled` → `handle.settled`, and so on for all sixteen —
  on the ledger row, the bus message and the **SSE `event:` field**.

  Forwarded harness events are renamed on the same stream: `tool_start` → `tool.started`,
  `agent_start` → `session.started` (it was the harness's _session_ beginning, never an agent's
  lifecycle), and `text` → `message.updated` (it was always a delta of exactly one message).

  **No aliases.** A permanent two-names-per-event table costs more than the break, so there is a
  one-time idempotent migration instead — it runs at every alineod boot and does nothing on a
  database that has already been through it.

  Anything reading the SSE stream by event name needs updating. In this repo that is `alineo-mcp`
  and the alineod docs, both changed here; the `run_watch` tool now returns the new names.

  alineod also emits a `LedgerEnvelope` to sinks beside every row it already wrote. Sinks are
  `@internal` for now — under the durable-execution decision the ledger is the system of record
  and a sink is an export path, so the public shape of that belongs with the work that owns
  export.

- d22672b: **BREAKING:** every MCP tool is renamed to `{subject}_{verb}`, dropping the `alineod_` /
  `alineo_` prefixes that named _which binary_ rather than _what the tool acts on_.

  | Before                                                                                                                     | Now                                                                                                          |
  | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `alineod_create_run` · `alineod_get_run` · `alineod_delete_run` · `alineod_watch_events`                                   | `run_start` · `run_get` · `run_stop` · `run_watch`                                                           |
  | `alineod_spawn_agent` · `_get_agent` · `_prompt_agent` · `_steer_agent` · `_pause_agent` · `_resume_agent` · `_stop_agent` | `agent_spawn` · `agent_get` · `agent_prompt` · `agent_steer` · `agent_pause` · `agent_resume` · `agent_stop` |
  | `alineod_get_result`                                                                                                       | `result_get`                                                                                                 |
  | `alineo_add_spec` · `_list_specs` · `_remove_spec` · `alineo_init`                                                         | `spec_add` · `spec_list` · `spec_remove` · `init`                                                            |

  An LLM picking a tool should be able to guess the name. `alineod_create_run` required knowing
  that a daemon called alineod exists.

  `run_stop`, not `run_delete`: the route aborts and closes every live agent but **keeps the
  ledger**. HTTP keeps `DELETE /runs/:runId` — the method carries the verb there; a tool name has
  to say it out loud.

  `@alineo-labs/schema` gains three subjects — `event`, `result`, `transcript` — and one verb,
  `deliver`. All four were already on the wire (`GET /agents/:id/transcript`,
  `GET /runs/:id/events`, `POST /agents/:id/inbox/deliver`); they were vocabulary in use, just not
  written down.

  `scripts/check-vocabulary.ts` now also checks MCP tool names and alineod's HTTP routes, so all
  four surfaces fail CI on an invented name.

- e185452: Add `closeWhen` to a run (plans/07-10-2026/close-when.md). `POST /runs` accepts
  `closeWhen: "explicit" | "quiescent"` (default `"explicit"`, today's exact behavior — a run
  stays open until a client deletes it). A run created with `closeWhen: "quiescent"` closes
  itself, with no client call, the moment every agent in it is terminal and has nothing left to
  deliver — alineod now tracks each run's open/closed state (a new `runs` projection table,
  folded from the new `run.closed` event) and reacts to it.

  New in `@alineo-labs/schema`: `CloseWhen`, the `closeWhen` field on `CreateRunBody` and
  `RunStarted`, the `RunClosed` event, and `closeWhen`/`state` on `TreeView` (`GET /runs/:id`).

  New in `alineo-mcp`: `run_start`'s `closeWhen` parameter, passed straight through to alineod.

  Also fixes a correctness gap in `apps/alineod`'s existing quiescence detection
  (`GET`/`POST /runs/:runId/await`, used by both the bare `closeWhen: "quiescent"` path and
  anyone already polling it): a `done`/`failed` member holding a pending inbox entry (held for
  its next prompt — not the same as a `paused` member, which was already excluded) could read as
  quiescent, even though something is still waiting to be delivered to it. `quiescence()` now
  requires a member's pending inbox to be empty too, not just its state to be terminal.

### Patch Changes

- de786a7: Config is now found, merged and validated in one place.

  `alineo.config.json` is located by walking up from the working directory (bounded by a `.git`
  directory, `$HOME`, or the filesystem root) instead of being read only from the exact working
  directory. Running a script from a subdirectory previously fell back to built-in defaults in
  silence, which looked identical to having no config at all.

  Sources are merged lowest-first — `~/.config/alineo/config.json`, then `alineo.config.json`,
  then `ALINEO_CONFIG_CONTENT` (inline JSON), then `ALINEO_SERVER_URL` / `ALINEO_API_KEY` /
  `ALINEO_USE_SERVER_PROXY`, then explicit options — validated once, then frozen. A malformed file
  or a bad value now fails with the offending key and file named, rather than being dropped.

  `Alineo.load()`, `.resume()`, `.reattach()` and `.attach()` accept `opts.config` to skip file and
  environment discovery entirely, for embedded callers and tests that must not depend on the
  working directory. The config is also read once per working directory now, not on every call.

  Three behaviour changes worth noting.

  A project config found by walking up will now apply where defaults were previously used.

  A global `~/.config/alineo/config.json` is merged under a project config instead of being ignored
  whenever a project config exists. The SDK previously ignored the global config entirely while
  `alineo-cli` already read it, so on a machine with a global config and no project config the two
  disagreed about `adapterPath` — and therefore used different agent snapshot caches. They now
  agree. If that describes your setup, the first `Alineo.load()` of each spec after upgrading
  rebuilds its snapshot at the new location instead of reusing the old one; nothing is lost, but
  expect one slow run per spec.

  A spec that relied on the built-in `adapterPath`/`agentsDir` defaults while a global config set
  different ones will now follow the global config. Pass `opts.config`, or set the value explicitly
  in a project `alineo.config.json`, to pin it.

- 31e97e5: `alineo init` now sets up the OpenSandbox server so a sandbox with a `networkPolicy` or
  `credentialProxy` can start.

  Before, a sandbox with a `networkPolicy` failed with `Egress sidecar did not become ready within
30s … Connection refused` although the sidecar was healthy. The server runs in a container and, with
  no `[docker].host_ip`, probed the sidecar at its own `127.0.0.1`. `init` now writes
  `host_ip = "host.docker.internal"` and starts the container with
  `--add-host host.docker.internal:host-gateway`. A `server.toml` from an earlier `init` gets the
  line added, and the OpenSandbox container is recreated to match (its snapshot db is in a bind
  mount, so nothing is lost).

  `init` also pulls `opensandbox/server:latest` when it creates the container. `docker run` reuses an
  image already on disk, however old, and an old `latest` can mismatch the pinned egress image.

  The docs now say that `networkPolicy` and `credentialProxy` are rejected by a server using the
  gVisor runtime.

- 14ecd92: `alineo init` now starts OpenSandbox and alineod with `--restart unless-stopped`, and sets that
  policy on containers an earlier `init` created. Before, a reboot or a Docker daemon restart left
  both down — OpenSandbox first, so nothing worked until `init` ran again, and alineod's crash
  recovery never got the chance to run because nothing restarted alineod. `docker stop` still
  sticks.
- db86c50: `alineo-mcp` now reports its real package version in the MCP `initialize` handshake (it was hardcoded to `0.1.0`), and its README no longer says the package is unpublished. Adds a docs page at `/docs/alineod/getting-started/mcp`.
- 680bced: alineod's wire contract and `ProjectConfig` move to `@alineo-labs/schema`.

  The wire contract gets its own entry point, `@alineo-labs/schema/alineod` — its `AgentSpec`
  would collide with the root's, and a consumer that only wants the vocabulary has no business
  importing a daemon's request bodies.

  **`alineo-mcp` deletes eleven hand-mirrored interfaces.** They were documented as deliberate —
  "typed against the wire contract, not against alineod's internal Zod schemas" — which was a
  fair objection while those schemas were an app's internals and stops being one now the contract
  is published. The boundary still holds: mcp talks to alineod over HTTP like any other client,
  and the two request bodies keep `spec: Record<string, unknown>`, because an MCP tool receives
  arbitrary JSON from a model and typing it as an `AgentSpec` would claim a guarantee that side
  of the wire cannot make.

  `ProjectConfig` (the shape of `alineo.config.json`) is now published, so someone writing that
  file by hand can get the type from the same place the tooling does. `@alineo-labs/config-shared`
  re-exports it and keeps the mechanism — discovery, precedence, the env overlay.

  Not done: `apps/telemetry` sharing `CliTelemetryEvent`. It has no dependencies at all and is
  deployed by hand onto a VPS, so a workspace dependency would make a standalone service need the
  monorepo built to start — a worse trade than thirteen fields written twice.

- Updated dependencies [f9d1c2e]
- Updated dependencies [a5bd004]
- Updated dependencies [e8756ae]
- Updated dependencies [228d8a6]
- Updated dependencies [548ba60]
- Updated dependencies [de786a7]
- Updated dependencies [5bbc193]
- Updated dependencies [316dd94]
- Updated dependencies [79b74cc]
- Updated dependencies [c2a9c22]
- Updated dependencies [d22672b]
- Updated dependencies [e604a70]
- Updated dependencies [228d8a6]
- Updated dependencies [bc8cb33]
- Updated dependencies [5f9c089]
- Updated dependencies [e185452]
- Updated dependencies [3b47fb1]
- Updated dependencies [680bced]
- Updated dependencies [06e7c2f]
- Updated dependencies [de786a7]
- Updated dependencies [8734d5f]
- Updated dependencies [f5f9999]
- Updated dependencies [be6be44]
  - @alineo-labs/schema@0.2.0
  - alineo@0.7.0

## 0.2.0

### Minor Changes

- 7f2f39d: New package: `alineo-mcp`, an MCP (Model Context Protocol) server exposing alineod's swarm-control HTTP + SSE API — creating runs, spawning/prompting/steering/pausing/stopping agents, watching live events, resolving results — plus local agent-spec management (`add`/`list`/`remove`) and a Docker bootstrap (`init`), as tools any MCP client (Claude Code, Claude Desktop, Cursor, …) can invoke.

### Patch Changes

- 7f2f39d: No behavior change: `alineo init`'s Docker orchestration, `alineo.config.json`/`server.toml` handling, and the Pi provider API key list were hand-copied between `alineo-cli` and `alineo-mcp` (justified at the time by `alineo-cli` only publishing its `bin`, not these internals as a library entry point) and had already drifted — the `alineo-mcp` copy was missing rationale comments the `alineo-cli` copy had, with no shared import or test to signal when one needed the same fix as the other. Both are now generated from one internal `@alineo-labs/cli-shared` module (private, never published — bundled into each consumer's own `dist` at build time), so `alineo init` and the `alineo_init` MCP tool can no longer silently diverge.
- 7f2f39d: Fix `alineo init` (and the `alineo_init` MCP tool) leaving alineod unreachable on Windows and Mac.

  alineod was started with `--network host` so it could reach OpenSandbox at the same `127.0.0.1` address a bare `bun run start` would — but Docker Desktop for Windows/Mac only publishes `--network host` container ports to the host behind an opt-in "Enable host networking" setting, so alineod would report healthy internally while `alineo_init`'s own health check (and everything else) timed out reaching it.

  On Windows/Mac, alineod now runs on the default bridge network with an explicit port mapping and reaches OpenSandbox via `host.docker.internal`, which Docker Desktop resolves without any special configuration; OpenSandbox's own `eip` is set to match so alineod can also follow the sandbox proxy URLs it hands back. Linux is unaffected — it keeps `--network host`, which works there natively. `alineo_init` also now detects and recreates a container that Docker reports as "running" but isn't actually reachable (the exact failure mode this fixes), and regenerates `server.toml` (restarting whatever's already running) when its `eip` no longer matches what the current platform needs, so existing installs pick up the fix on their next `init` rather than staying stuck.

  Trade-off on Windows/Mac: a host-based client talking to the _same_ `alineo init`-managed OpenSandbox directly (not through alineod) can no longer follow its sandbox proxy URLs, since the host can't reliably resolve `host.docker.internal` back to itself. Use `uvx opensandbox-server` instead for that case (see the root `CLAUDE.md`'s "Local OpenSandbox setup").

- 7f2f39d: Fix regressions from the Windows/Mac `alineo init` networking fix: `server.toml` is no longer clobbered on every `init` (only its `eip` line is patched in place, preserving hand-edited `networkPolicy`/`credentialProxy`/egress settings), the alineod reachability probe no longer false-negatives a healthy-but-slow-to-answer container into a destructive recreate, a wrong host-networking platform guess now falls back to bridge networking + `host.docker.internal` automatically instead of leaving alineod permanently unreachable, `readConfig()` no longer crashes on a partial `defaults` block in `alineo.config.json`, and `alineo add`'s `registryDependencies` resolution now detects circular dependencies instead of looping forever.
- Updated dependencies [7f0d5c2]
  - alineo@0.6.0

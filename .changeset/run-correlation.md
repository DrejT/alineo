---
"@alineo-labs/core": minor
"alineo": minor
"@alineo-labs/sqlite": minor
"@alineo-labs/postgres": minor
"@alineo-labs/agent": minor
"alineo-cli": minor
---

Add `runId` — a first-class way to correlate sandboxes belonging to the same logical run, surfaced through `SandboxDetails.runId` and filterable via `client.sandboxes.list({ runId })`/`listByName({ runId })`.

- `SandboxOptions.runId` (optional, defaults to a fresh `crypto.randomUUID()` if omitted) is recorded on every sandbox-creation path (`client.sandbox()`, `client.resume()`, `client.restoreSnapshot()`, `sb.fork()`, environment-backed sandboxes) — a resumed, restored, or forked sandbox always inherits its origin's `runId` rather than getting a new one.
- `sb.fork(tag?, runId?)` gains an optional explicit override, needed across a process boundary (e.g. `alineo fork`, which re-`Agent.attach()`es in a brand-new CLI process with no access to the original in-memory closure) — same reasoning `ALINEO_SPAWN_DEPTH` already established, generalized to run identity.
- `Agent.load()`/`Agent.resume()` accept an optional `runId`, bake `ALINEO_RUN_ID` into the sandbox's env alongside `ALINEO_SPAWN_DEPTH`/`ALINEO_MAX_AGENTS`/`ALINEO_OBSERVABILITY`, and expose it as `agent.runId`. `Agent.spawn()`/`alineo fork` force-inherit it into every forked child, tamper-resistant like the existing budget fields. `alineo spawn` gains a `--run-id` flag.
- `runId` also rides along in `SandboxOptions.metadata`/`CreateSandboxOptions.metadata` at every creation path, since the ledger alone can't correlate sandboxes across separate adapter instances (e.g. a forked child writing to its own in-container ledger file) — the OpenSandbox control plane is the one channel every caller shares regardless of adapter, and its `Sandbox` type already declares (and, verified against a live server, actually echoes back) `metadata`.
- Both storage adapters (`@alineo-labs/sqlite`, `@alineo-labs/postgres`) extend their aggregation query to surface `runId` on `SandboxDetails` and support it as a `ListSandboxOptions` filter — no schema migration needed, read out of the existing JSON payload.

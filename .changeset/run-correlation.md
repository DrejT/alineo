---
"@drej/core": minor
"drej": minor
"@drej/sqlite": minor
"@drej/postgres": minor
"@drej/agent": minor
"drejx": minor
---

Add `runId` — a first-class way to correlate sandboxes belonging to the same logical run, surfaced through `SandboxDetails.runId` and filterable via `client.sandboxes.list({ runId })`/`listByName({ runId })`.

- `SandboxOptions.runId` (optional, defaults to a fresh `crypto.randomUUID()` if omitted) is recorded on every sandbox-creation path (`client.sandbox()`, `client.resume()`, `client.restoreSnapshot()`, `sb.fork()`, environment-backed sandboxes) — a resumed, restored, or forked sandbox always inherits its origin's `runId` rather than getting a new one.
- `sb.fork(tag?, runId?)` gains an optional explicit override, needed across a process boundary (e.g. `drejx fork`, which re-`Agent.attach()`es in a brand-new CLI process with no access to the original in-memory closure) — same reasoning `DREJX_SPAWN_DEPTH` already established, generalized to run identity.
- `Agent.load()`/`Agent.resume()` accept an optional `runId`, bake `DREJX_RUN_ID` into the sandbox's env alongside `DREJX_SPAWN_DEPTH`/`DREJX_MAX_AGENTS`/`DREJX_OBSERVABILITY`, and expose it as `agent.runId`. `Agent.spawn()`/`drejx fork` force-inherit it into every forked child, tamper-resistant like the existing budget fields. `drejx spawn` gains a `--run-id` flag.
- `runId` also rides along in `SandboxOptions.metadata`/`CreateSandboxOptions.metadata` at every creation path, since the ledger alone can't correlate sandboxes across separate adapter instances (e.g. a forked child writing to its own in-container ledger file) — the OpenSandbox control plane is the one channel every caller shares regardless of adapter, and its `Sandbox` type already declares (and, verified against a live server, actually echoes back) `metadata`.
- Both storage adapters (`@drej/sqlite`, `@drej/postgres`) extend their aggregation query to surface `runId` on `SandboxDetails` and support it as a `ListSandboxOptions` filter — no schema migration needed, read out of the existing JSON payload.

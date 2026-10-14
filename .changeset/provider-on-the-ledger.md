---
"@alineo-labs/errors": patch
"@alineo-labs/schema": patch
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"@alineo-labs/sqlite": patch
"@alineo-labs/postgres": patch
"alineo": patch
---

Record which sandbox provider owns each sandbox.

- `sandbox.created` gains an optional `provider` (`"opensandbox"` today). A row with no
  `provider` means `"opensandbox"`. There is no migration: readers apply the default.
- `SandboxDetails.provider` and `ListSandboxOptions.provider` (core). Both SQLite and Postgres
  adapters derive it from the `sandbox.created` payload, the same way they derive `runId`.
  `DEFAULT_PROVIDER_ID` is exported from core.
- `Sandbox.resume()` throws `PROVIDER_MISMATCH` (409) when the session was created on another
  provider, instead of sending a sandbox id to a server that has never heard of it.
- `AgentSnapshotStore` includes the provider in its key. OpenSandbox keeps the legacy key, so
  an existing `agent-snapshots.json` keeps working, and saving for one provider no longer
  deletes another provider's snapshot of the same spec.

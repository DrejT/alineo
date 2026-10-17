---
"@alineo-labs/core": patch
"@alineo-labs/sandbox": patch
"@alineo-labs/schema": patch
"alineo": patch
---

Carry the sandbox provider through to alineod's agent view.

- `SandboxHandle.provider` reports the provider that owns the sandbox. The client that created the
  handle sets it. The `alineo` package re-exports `DEFAULT_PROVIDER_ID`.
- `agent.provisioned` gains an optional `provider`. A event with none means `"opensandbox"`.
- The `agents` projection gains a `provider` column, derived from the ledger on `rebuild()`, and
  `AgentView.provider` is in `GET /agents/:id` and the run tree (`null` until the agent has a sandbox).

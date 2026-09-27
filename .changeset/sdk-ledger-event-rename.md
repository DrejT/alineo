---
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"@alineo-labs/sqlite": minor
"@alineo-labs/postgres": minor
"@alineo-labs/ledger": minor
---

**BREAKING:** the SDK ledger's event names are namespaced. `LedgerEvent` members are unchanged;
their **values** are not:

```
sandbox_created    → sandbox.created        exec_start    → exec.started
checkpoint_created → sandbox.checkpoint_created   exec_event    → exec.output
credential_bound   → credential.bound       exec_complete → exec.completed
run_started        → workflow.started       checkpoint    → step.checkpointed
```

`run_started` meant a workflow run here and a *swarm* run in alineod. It is `workflow.started`
now, and `run.started` belongs to alineod alone.

`LedgerEvent.Snapshot` is deprecated and emits `sandbox.checkpoint_created` — the same value
`CheckpointCreated` has, because that is what it always recorded: a sandbox checkpoint the
workflow engine happened to take.

**Code using the `LedgerEvent` enum keeps compiling.** Code comparing `entry.event` against a
raw string does not, and neither does a query filtering on one.

**Existing databases migrate on `connect()`** — both the sqlite and postgres adapters run a
one-time, idempotent rename of `alineo_events.event`. It matters that it runs before any read:
`getSandboxDetails` aggregates on literal names, so an unmigrated row does not error, it
silently stops existing. **One-way**: an older SDK reading a migrated database would find
sessions it cannot see.

Both adapters share one statement from `@alineo-labs/ledger` — a single `CASE` over one scan
rather than ~25 `UPDATE`s, because `event` is unindexed on that table.

`Sandbox` accepts an `@internal` `sink` that receives a `LedgerEnvelope` for every event,
beside the ledger write. Synchronous, isolated, and it runs *before* the ledger queue, so a
slow or broken exporter can neither delay nor fail the operation it is exporting.

Unchanged: the harness `AgentEvent` stream (`tool_start`, `text`, …). Those are the SDK's
public streaming API, not what it stores; alineod translates them at its own boundary.

# @alineo-labs/ledger

## 0.2.0

### Minor Changes

- c2a9c22: The ledger envelope, every event definition, and a package that does something with them.

  **`@alineo-labs/schema`** gains the envelope and the event registry:

  ```ts
  interface LedgerEnvelope<T, D> {
    v: 1;
    ts: number;
    type: T;
    runId?: string;
    agentId?: string;
    turnId?: string;
    causedBy?: EventRef;
    durable?: { aggregate: string; seq: number; version: number };
    data: D;
  }
  ```

  Before it, the same idea was written three ways — the SDK's `LedgerEntry` (ordered by
  timestamp), alineod's ledger row (ordered by `seq`), and the harness's bare
  `{ type, ...fields }` stream. A consumer reading one run end to end had to know all three.

  59 events are now defined, namespaced **by subject rather than by emitting layer** —
  `agent.spawned`, not `alineod.agent_spawned`. Someone reading one mixed stream needs to know
  what an event is _about_, not which process produced it. `defineEvent` refuses a name outside
  `<subject>.<past_tense_verb>`, a subject outside `SUBJECTS`, and a duplicate type.

  A second entry point, `@alineo-labs/schema/types`, carries the types with no Zod in the graph,
  so a package with no validator dependency can take the envelope's shape and have it erase at
  compile time.

  **`@alineo-labs/ledger`** is new: `EventSink`, `composeSinks`, `memorySink`, `jsonlSink`,
  `LedgerStorage` + `MemoryStorage`, and the fold helpers the equivalence gate uses.

  A sink is **synchronous and must not throw**. Both constraints come from where sinks sit — on
  the write path of a sandbox operation. An async sink invites a caller to await it, so a slow
  export becomes sandbox backpressure; a throwing sink fails the operation that emitted the
  event, which is exactly backwards.

  Nothing emits envelopes yet. This is the shape, its definitions, and the machinery — the SDK
  and alineod adopt it next.

- c9c8f2f: **BREAKING:** the SDK ledger's event names are namespaced. `LedgerEvent` members are unchanged;
  their **values** are not:

  ```
  sandbox_created    → sandbox.created        exec_start    → exec.started
  checkpoint_created → sandbox.checkpoint_created   exec_event    → exec.output
  credential_bound   → credential.bound       exec_complete → exec.completed
  run_started        → workflow.started       checkpoint    → step.checkpointed
  ```

  `run_started` meant a workflow run here and a _swarm_ run in alineod. It is `workflow.started`
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
  beside the ledger write. Synchronous, isolated, and it runs _before_ the ledger queue, so a
  slow or broken exporter can neither delay nor fail the operation it is exporting.

  Unchanged: the harness `AgentEvent` stream (`tool_start`, `text`, …). Those are the SDK's
  public streaming API, not what it stores; alineod translates them at its own boundary.

### Patch Changes

- Updated dependencies [f9d1c2e]
- Updated dependencies [e8756ae]
- Updated dependencies [228d8a6]
- Updated dependencies [316dd94]
- Updated dependencies [c2a9c22]
- Updated dependencies [d22672b]
- Updated dependencies [e604a70]
- Updated dependencies [e185452]
- Updated dependencies [3b47fb1]
- Updated dependencies [680bced]
- Updated dependencies [8734d5f]
- Updated dependencies [f5f9999]
- Updated dependencies [be6be44]
  - @alineo-labs/schema@0.2.0

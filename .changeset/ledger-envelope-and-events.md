---
"@alineo-labs/schema": minor
"@alineo-labs/ledger": minor
---

The ledger envelope, every event definition, and a package that does something with them.

**`@alineo-labs/schema`** gains the envelope and the event registry:

```ts
interface LedgerEnvelope<T, D> {
  v: 1; ts: number; type: T;
  runId?: string; agentId?: string; turnId?: string;
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
what an event is *about*, not which process produced it. `defineEvent` refuses a name outside
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

# `@alineo-labs/memory`

A provider-agnostic memory layer for alineo agents: working memory, semantic recall, and
episodic recall over the existing ledger — scoped by a durable `resourceId` that survives past
any one sandbox session.

This package owns memory **concepts and scoping**. It does not own or assume a storage
backend — you bring your own `IWorkingMemoryProvider` / `ISemanticMemoryProvider` (a real
Postgres/pgvector or SQLite/sqlite-vec backend, or one of the in-memory reference
implementations shipped here for development and tests).

## Why `resourceId`, not `sandboxId`

A `sandboxId` identifies one sandbox _session_ — what the ledger already keys episodic events
by. A `resourceId` is a durable identity (a user, an account, a project) expected to outlive
any number of sandbox sessions. Working and semantic memory are keyed by `resourceId` because
their entire point is surviving past the session they were learned in; conflating the two
would silently break that guarantee.

```ts
import type { ResourceRef } from "@alineo-labs/memory";

const ref: ResourceRef = { resourceId: "user-42" }; // teamId?: string for shared/team scoping
```

## Three capabilities, three independent slots

Memory is split by capability, not unified into one adapter — real backends support genuinely
different capability subsets, so a monolithic interface would force fake implementations of
capabilities a backend doesn't have.

### Working memory — required

Structured per-resource key/value facts. Every `Memory` instance needs at least this.

```ts
import { Memory, InMemoryWorkingMemoryProvider } from "@alineo-labs/memory";

const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

await memory.workingMemory.set(ref, "preferredLanguage", "TypeScript");
await memory.workingMemory.get(ref, "preferredLanguage"); // "TypeScript"
await memory.workingMemory.list(ref); // { preferredLanguage: "TypeScript" }
await memory.workingMemory.delete(ref, "preferredLanguage");
```

### Semantic memory — optional

Vector recall over remembered facts. Omitting it is a first-class, typed state: calling
`remember()`/`recall()` on a `Memory` with no semantic provider throws `MemoryCapabilityError`
rather than silently no-op'ing or returning an empty array that looks like "no facts matched."

```ts
import {
  Memory,
  InMemoryWorkingMemoryProvider,
  InMemorySemanticMemoryProvider,
} from "@alineo-labs/memory";

const memory = new Memory({
  workingMemory: new InMemoryWorkingMemoryProvider(),
  semantic: new InMemorySemanticMemoryProvider(myEmbeddingProvider),
});

await memory.remember(ref, { content: "prefers dark mode" });
const facts = await memory.recall(ref, "UI preferences", { topK: 5 });
```

`EmbeddingProvider` is a minimal `{ id, embed(texts) }` shape — pass any embedding model you
like; this package never depends on a concrete one.

### Episodic memory — a function, not a provider

A read-shaped view over the sandbox ledger alineo already has (`@alineo-labs/core`'s
`IStorageAdapter`), reshaped by `resourceId`. No new storage, no ledger schema change.

```ts
import { episodicRecall } from "@alineo-labs/memory";

const entries = await episodicRecall(adapter, ref, { limit: 100 });
```

By default, `episodicRecall` finds sessions belonging to a resource by matching the ledger's
`name` field against `resourceId` — i.e. it expects sandboxes for that resource to have been
named after it. If your app names sandboxes differently, supply `resolveSessions` to map a
`ResourceRef` to the sessions that belong to it:

```ts
await episodicRecall(adapter, ref, {
  resolveSessions: async (adapter, ref) => myOwnResourceIndex.lookup(ref.resourceId),
});
```

## Reference implementations are not production backends

`InMemoryWorkingMemoryProvider` and `InMemorySemanticMemoryProvider` are process-local,
non-durable, and not shared across processes — they exist to prove the interfaces compose end
to end and to give tests something real to run against, the same role `InMemoryStore` plays in
LangGraph. Real backend packages (Postgres/pgvector, SQLite/sqlite-vec, or a wrapper around a
dedicated memory vendor) are a separate, later concern.

## What's intentionally out of scope here

- Real backend packages — none shipped yet.
- Team/RLS enforcement mechanics — `ResourceRef.teamId` is passed to every provider; what a
  given provider does with it (Postgres RLS, app-layer filtering, ignoring it) is that
  provider's problem.
- Branchable/forkable episodic memory — `episodicRecall` returns one flat, time-ordered
  stream today. Worth revisiting if the ledger grows a branch/lane concept.
- Checkpoint/resume binding for `Memory` itself.

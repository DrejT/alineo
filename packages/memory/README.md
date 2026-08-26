# `@alineo-labs/memory`

A provider-agnostic memory layer for alineo agents: working memory, semantic recall, and
episodic recall over the existing ledger — scoped by a durable `resourceId` that survives past
any one sandbox session.

This package owns memory **concepts, scoping, and pipeline** (injection, compaction,
lifecycle hooks). It does not own a storage backend itself — bring your own
`IWorkingMemoryProvider` / `ISemanticMemoryProvider`, whether that's the in-memory reference
implementations shipped here, the file-based `@alineo-labs/sqlite-memory` backend, or the
shared `@alineo-labs/postgres-memory` backend.

## Why `resourceId`, not `sandboxId`

A `sandboxId` identifies one sandbox *session*. A `resourceId` is a durable identity (a user,
an account, a project) expected to outlive any number of sandbox sessions. Working and
semantic memory are keyed by `resourceId` because their entire point is surviving past the
session they were learned in.

`resourceId` (and `parentSandboxId`, for forked sandboxes) ride along in the ledger's existing
`sandbox_created` event payload — the same mechanism `SandboxDetails.runId` already used —
so there's no ledger schema change. Set it when creating a sandbox:

```ts
const sb = await client.sandbox({
  image: "node:22",
  resources: { cpu: "500m", memory: "512Mi" },
  resourceId: "user-42", // ties this session's memory to a durable resource
});
```

`resume()`, `restoreSnapshot()`, and `sb.fork()` all inherit the originating session's
`resourceId` automatically, the same way they already inherit `runId`.

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
`remember()`/`recall()` on a `Memory` with no semantic provider throws `MemoryCapabilityError`.

```ts
import { Memory, InMemoryWorkingMemoryProvider, InMemorySemanticMemoryProvider } from "@alineo-labs/memory";

const memory = new Memory({
  workingMemory: new InMemoryWorkingMemoryProvider(),
  semantic: new InMemorySemanticMemoryProvider(myEmbeddingProvider),
});

await memory.remember(ref, { content: "prefers dark mode" });
const facts = await memory.recall(ref, "UI preferences", { topK: 5 });
```

`EmbeddingProvider` is a minimal `{ id, embed(texts) }` shape — pass any embedding model you
like. `@alineo-labs/model-providers` ships `createNvidiaEmbeddingProvider()`, matching this
shape structurally with no dependency on this package at all.

### Episodic memory — a function, not a provider

A read-shaped view over the sandbox ledger, reshaped by `resourceId`. No new storage.

```ts
import { episodicRecall } from "@alineo-labs/memory";

const entries = await episodicRecall(adapter, ref, { limit: 100 });

// Include ancestor sessions reached via sb.fork()'s parentSandboxId chain:
const withHistory = await episodicRecall(adapter, ref, { branch: "lineage" });
```

By default, sessions are resolved by matching `SandboxDetails.resourceId` (or, for ledger data
written before that field existed, by matching the ledger's `name` against `resourceId`).
Supply `resolveSessions` to use a different convention entirely.

## Real backends

| Package | Working memory | Semantic memory | Notes |
|---|---|---|---|
| `@alineo-labs/memory` (this package) | `InMemoryWorkingMemoryProvider` | `InMemorySemanticMemoryProvider` | Process-local, non-durable — reference implementations only. |
| `@alineo-labs/sqlite-memory` | `SQLiteWorkingMemoryProvider` | `SQLiteSemanticMemoryProvider` | File-based via `bun:sqlite`, zero external services, survives restarts. Cosine-similarity scan in JS (no vector index). |
| `@alineo-labs/postgres-memory` | `PostgresWorkingMemoryProvider` | `PostgresSemanticMemoryProvider` | Shared, multi-process backend. Row-level security isolates `teamId`-scoped rows. Cosine-similarity scan in JS by default — see the package's own doc comment for the `pgvector` upgrade path. |

```ts
import { Memory } from "@alineo-labs/memory";
import { SQLiteWorkingMemoryProvider, SQLiteSemanticMemoryProvider } from "@alineo-labs/sqlite-memory";
import { createNvidiaEmbeddingProvider } from "@alineo-labs/model-providers";

const memory = new Memory({
  workingMemory: new SQLiteWorkingMemoryProvider("./alineo-memory.db"),
  semantic: new SQLiteSemanticMemoryProvider("./alineo-memory.db", createNvidiaEmbeddingProvider()),
});
```

Neither backend package has been run against a live database in this repo's own test suite
(no Postgres instance, and the SQLite one is unit-tested with `bun:sqlite` directly) — they
ship type-checked and, for SQLite, tested against a real file; treat the Postgres one as
reviewed-but-unverified until it's run against an actual server.

## Compaction

A `remember()`'d fact stays verbatim forever unless pruned. `compactSemanticMemory()` (or
`Memory.compactSemanticMemory()`) drops old/excess facts, for any provider implementing the
optional `IPrunableSemanticMemoryProvider` capability (`listAll`/`forget` — all three semantic
providers above support it):

```ts
await memory.compactSemanticMemory(ref, { maxFacts: 500, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
```

Age-based removal runs first; the count cap is then applied to whatever's left. Throws if the
configured provider doesn't support pruning.

## Sandbox lifecycle binding

`createMemoryLifecycleHooks(memory, ref)` returns a `SandboxHooks` object (composable via
`@alineo-labs/core`'s `composeHooks()`) that records the most recently active `sandboxId` and
the most recent checkpoint's metadata into working memory — a durable answer to "what was the
last checkpoint for this resource" without re-deriving it from the ledger every time. It does
not restore sandbox state itself; that's `@alineo-labs/core`'s job.

```ts
import { composeHooks } from "@alineo-labs/core";
import { createMemoryLifecycleHooks } from "@alineo-labs/memory";

const sb = await client.sandbox({
  image: "node:22",
  resources: { cpu: "500m", memory: "512Mi" },
  resourceId: ref.resourceId,
  hooks: composeHooks([createMemoryLifecycleHooks(memory, ref)]),
});
```

## Agent wiring

`alineo`'s `Alineo` class accepts an optional `memory` on `load()`/`resume()`/`attach()`, and
`spawn()` carries it over to the child automatically:

```ts
const agent = await Alineo.load(spec, { adapter, memory });
await agent.memory?.remember(agent.resourceRef, { content: "user prefers concise answers" });
```

`agent.resourceRef` defaults `resourceId` to the agent's own `name` — the same convention
`episodicRecall()`'s default resolver expects, so no extra wiring is needed to make episodic
recall work for an agent's own sandbox sessions.

## What's intentionally out of scope here

- Approximate-nearest-neighbor vector indexing (pgvector/sqlite-vec) — both shipped backends
  do an in-JS cosine scan; fine at moderate scale, not a production ANN setup.
- Team/RLS enforcement beyond what `@alineo-labs/postgres-memory`'s migration defines — a
  SQLite or in-memory deployment gets structural isolation only, not a security boundary.
- Full branch/lane episodic memory — `episodicRecall({branch: "lineage"})` walks fork
  ancestry, but alineo's ledger still has no first-class branch concept the way e.g. Pi's own
  session storage does.
- Restoring sandbox filesystem/process state from a checkpoint — `createMemoryLifecycleHooks`
  only records checkpoint *metadata* into working memory; the actual restore is
  `@alineo-labs/core`'s `resume()`.

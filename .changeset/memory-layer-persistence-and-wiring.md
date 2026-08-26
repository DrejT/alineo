---
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"@alineo-labs/sqlite": minor
"@alineo-labs/postgres": minor
"@alineo-labs/sqlite-memory": minor
"@alineo-labs/postgres-memory": minor
"@alineo-labs/memory": minor
"alineo": minor
---

Fill out the `@alineo-labs/memory` provider-agnostic layer introduced in a prior release:

**Ledger scoping (`@alineo-labs/core`, `@alineo-labs/sandbox`, `@alineo-labs/sqlite`,
`@alineo-labs/postgres`)** — `SandboxOptions.resourceId` threads a durable resource identity
through the ledger's existing `sandbox_created` payload, the same additive mechanism `runId`
already used (no schema migration). `resume()`, `restoreSnapshot()`, and `sb.fork()` inherit it
automatically. `sb.fork()` also now records `parentSandboxId`, letting episodic memory walk a
fork's ancestry. Both fields are optional and exposed on `SandboxDetails`/`ListSandboxOptions`.

**Real persistence backends** — two new packages, `@alineo-labs/sqlite-memory` (file-based, via
`bun:sqlite`, zero infrastructure) and `@alineo-labs/postgres-memory` (shared, multi-process,
with row-level-security team isolation), each implementing `IWorkingMemoryProvider` and the
new `IPrunableSemanticMemoryProvider` capability. Both rank semantic recall with an in-JS
cosine scan (no vector index); the Postgres package's `vector` column is a plain array today,
documented with the `pgvector` upgrade path.

**Compaction** — `compactSemanticMemory()` (and `Memory.compactSemanticMemory()`) prunes old or
excess facts via the new optional `IPrunableSemanticMemoryProvider` capability
(`listAll`/`forget`, keyed by a stable per-fact `id`), supported by all three semantic
providers now shipping (in-memory, SQLite, Postgres).

**Lifecycle binding** — `createMemoryLifecycleHooks(memory, ref)` returns a composable
`SandboxHooks` object that records the most recent checkpoint and active session into working
memory, using `@alineo-labs/core`'s existing hooks extension point rather than any change to
sandbox lifecycle internals.

**Episodic memory** — `episodicRecall()`'s default session resolver now matches on
`resourceId` directly (falling back to the old name-matching convention for pre-existing
ledger data), and gains a `branch: "lineage"` option that walks `parentSandboxId` ancestry.

**Agent wiring (`alineo`)** — `Alineo.load()`/`.resume()`/`.attach()` accept an optional
`memory: Memory`; `.spawn()` carries it over to the child automatically. `agent.resourceRef`
defaults to `{ resourceId: agent.name }`, matching `episodicRecall()`'s own naming convention.

**Embeddings (`@alineo-labs/model-providers`, unpublished/private)** — `createNvidiaEmbeddingProvider()`
wraps NVIDIA NIM's embeddings endpoint, duck-typed to `EmbeddingProvider`'s shape with no
dependency on `@alineo-labs/memory`.

---
"@alineo-labs/memory": minor
---

Introduce `@alineo-labs/memory`, a provider-agnostic memory layer for alineo agents:

- `ResourceRef` — a durable `resourceId`/`teamId` scoping identity, deliberately distinct from
  a sandbox session's `sandboxId`, so memory can survive past any one sandbox.
- `IWorkingMemoryProvider` — required structured per-resource key/value memory, plus an
  `InMemoryWorkingMemoryProvider` reference implementation.
- `ISemanticMemoryProvider` — optional vector recall, plus an `InMemorySemanticMemoryProvider`
  reference implementation (naive cosine similarity) and a minimal `EmbeddingProvider` shape.
  Omitting a semantic provider is a first-class, typed state: `Memory.remember()`/`recall()`
  throw `MemoryCapabilityError` rather than silently no-op'ing.
- `episodicRecall()` — a pure function reading episodic memory back out of the existing
  `@alineo-labs/core` ledger via `IStorageAdapter`, reshaped by `resourceId`. No new storage,
  no ledger schema change.
- `Memory` — the facade tying the three together.

Real storage backends (Postgres/pgvector, SQLite/sqlite-vec, or similar) are a separate,
later concern — this package owns memory concepts and scoping only.

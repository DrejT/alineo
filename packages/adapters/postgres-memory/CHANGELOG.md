# @alineo-labs/postgres-memory

## 0.2.0

### Minor Changes

- 223390e: Fill out the `@alineo-labs/memory` provider-agnostic layer introduced in a prior release:

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

### Patch Changes

- 223390e: Build the four differentiators no capability-matching framework can structurally replicate,
  since each depends on alineo's own execution ledger or sandbox substrate:

  **Verified memory, actually enforced** — every `MemoryFact` returned by `recall()`/`listAll()`
  now carries a `verified` flag, computed (never caller-set) as `sourceRef != null` at
  `remember()` time by all three semantic providers (in-memory, SQLite, Postgres — no schema
  change, derived from the existing `source_sandbox_id` column). A fact traceable to a real
  ledger entry is now distinguishable from a free-form one.

  **True forkable memory** — `Memory.fork(parentRef, childResourceId)` copies a resource's
  working memory (always) and semantic memory (when the provider supports the pruning
  capability) into a brand-new, independently mutable resource scope — the memory-layer
  counterpart to `sb.fork()`'s copy-on-write sandbox snapshot. `Alineo.spawn()` now calls this
  automatically when the parent agent has `.memory` configured.

  **Branch-true episodic memory** — `episodicTree()` reconstructs the actual fork tree from
  `parentSandboxId` (each session as its own node, forked sessions nested under their parent)
  instead of `episodicRecall`'s flattened chronological stream, so an agent can distinguish "what
  happened on this branch" from "what happened on a sibling branch forked from the same point."

  **Team access control extended to every backend** — `withTeamAccessControl()` /
  `withTeamAccessControlSemantic()` wrap any provider with app-layer `teamId` enforcement
  (checked via a caller-supplied `TeamAccessChecker`, throwing `MemoryAccessDeniedError` before
  the wrapped provider is touched), closing the gap where only `@alineo-labs/postgres-memory`'s
  row-level security was a real access-control boundary — every other provider only isolated
  `teamId` structurally. Composable with Postgres's own RLS for defense-in-depth.

  88 memory package tests (was 63), 18 sqlite-memory tests (was 17). Full workspace typecheck
  (17/17) and lint pass.

- Updated dependencies [223390e]
- Updated dependencies [223390e]
- Updated dependencies [223390e]
- Updated dependencies [223390e]
  - @alineo-labs/memory@0.2.0

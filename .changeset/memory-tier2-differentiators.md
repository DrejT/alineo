---
"@alineo-labs/memory": minor
"@alineo-labs/sqlite-memory": patch
"@alineo-labs/postgres-memory": patch
"alineo": minor
---

Build the four differentiators no capability-matching framework can structurally replicate,
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

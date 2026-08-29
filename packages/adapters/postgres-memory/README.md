# @alineo-labs/postgres-memory

Shared, multi-process `@alineo-labs/memory` backend for [alineo](https://alineo.tech), via Postgres.

```bash
bun add @alineo-labs/postgres-memory
```

For local dev with zero infrastructure, use [`@alineo-labs/sqlite-memory`](https://github.com/DrejT/alineo/tree/main/packages/adapters/sqlite-memory) instead.

---

## Usage

```ts
import { Memory } from "@alineo-labs/memory";
import {
  PostgresWorkingMemoryProvider,
  PostgresSemanticMemoryProvider,
} from "@alineo-labs/postgres-memory";

const memory = new Memory({
  workingMemory: new PostgresWorkingMemoryProvider(connectionString),
  semantic: new PostgresSemanticMemoryProvider(connectionString, myEmbeddingProvider),
});
```

Migrations run lazily on first query — no separate `connect()` step.

## Team isolation

Rows carrying a `ResourceRef.teamId` are isolated via row-level security: every query runs
inside a transaction that first sets `app.team_id` for that transaction, and each table's RLS
policy only allows access to rows where `team_id` is `NULL` or matches. `FORCE ROW LEVEL
SECURITY` is set so this applies even to the role that owns the tables. See `src/migrations.ts`
for the exact policy.

## Vector search

`recall()` uses a real `pgvector` HNSW index whenever the connected Postgres instance allows
`CREATE EXTENSION IF NOT EXISTS vector` (on by default on Supabase/Neon, allowlisted on RDS,
unavailable on a bare Postgres with no superuser access) — falling back to an in-JS
cosine-similarity scan over every row for the resource otherwise. Check
`PostgresSemanticMemoryProvider.hasVectorIndex` to see which path is active; the plain `vector`
(`double precision[]`) column on `alineo_semantic_memory` is always populated regardless, so the
fallback is never a degraded schema, only a slower code path over the same data. The indexed
path's own table (`alineo_semantic_vec`, created lazily once the embedding dimension is known)
gets identical row-level-security policies to the primary table, so scoping doesn't depend on
which path a given call takes.

This package has not been run against a live Postgres instance in this repo's own test suite
(none is available here) — it ships type-checked, matching `@alineo-labs/postgres`'s own
testing posture, not integration-tested against a real server. That applies to this HNSW path
too: it's implemented against `pgvector`'s documented SQL surface, not verified against a live
instance with the extension installed.

---

## License

Apache 2.0

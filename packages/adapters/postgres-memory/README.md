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

The `vector` column is a plain `double precision[]` array, not a `pgvector` column — this
works against any Postgres instance with zero extensions, ranked by an in-JS cosine-similarity
scan over every row for the resource. For indexed ANN search at real scale, add the `pgvector`
extension, change the column to `vector(N)`, and replace the scan in `recall()` with an
`ORDER BY vector <=> query_vector LIMIT k` query — everything else (scoping, RLS, pruning)
stays the same.

This package has not been run against a live Postgres instance in this repo's own test suite
(none is available here) — it ships type-checked, matching `@alineo-labs/postgres`'s own
testing posture, not integration-tested against a real server.

---

## License

Apache 2.0

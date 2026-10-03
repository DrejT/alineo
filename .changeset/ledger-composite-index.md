---
"@alineo-labs/sqlite": patch
"@alineo-labs/postgres": patch
---

Replace `alineo_events`'s two single-column indexes (`sandbox_id`, `name`) with one composite
index on `(name, sandbox_id, ts, id)`, matching the shape every hot read actually queries
(`WHERE name = ? AND sandbox_id = ? ORDER BY ts`) instead of forcing SQLite/Postgres to pick one
index, filter the rest, and sort separately. `id` is a tie-breaker only — `ts` stays the primary
sort key, since callers can append entries out of timestamp order.

`@alineo-labs/sqlite`'s table definition also drops `AUTOINCREMENT` from `alineo_events.id` —
an append-only log doesn't need SQLite's no-rowid-reuse guarantee, and `AUTOINCREMENT` pays for
it with an extra `sqlite_sequence` write on every insert. Only affects freshly-created
databases; an existing one keeps its current `id` column as-is (SQLite can't retroactively
strip `AUTOINCREMENT` from a table that already has it, and it's a minor insert-cost
difference, not a correctness one).

The old indexes are dropped on `connect()` for an already-existing database of either backend,
not just skipped on a new one.

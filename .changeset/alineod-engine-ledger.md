---
"@alineo-labs/core": patch
"@alineo-labs/sqlite": patch
---

Add `IEngineLedger`, a generic two-level-partition append-only ledger primitive (durability-roadmap.md M3, chunk 3.1b), and `SQLiteEngineLedger`, its `bun:sqlite` implementation. `apps/alineod`'s swarm ledger (`apps/alineod/src/state/db.ts`) now binds onto this shared, tested implementation instead of hand-rolling its own `bun:sqlite` queries — bound onto its *existing* `ledger` table and `run_id`/`agent_id` columns via `SQLiteEngineLedgerSchema`, not a renamed one, so the physical schema and every other file addressing that table directly are unaffected.

Purely additive — no existing export's signature changes.

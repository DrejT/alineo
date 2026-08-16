---
"@alineo-labs/sqlite": patch
---

`SQLiteAdapter`'s constructor now creates missing parent directories before opening the
database file. `bun:sqlite`'s `create: true` only creates the db *file*, not its containing
directory, so the common `new SQLiteAdapter("./.alineo/ledger.db")` pattern threw
`SQLITE_CANTOPEN` on a fresh checkout unless `.alineo/` already happened to exist -- hit this
independently on three separate examples (`pi-agent`, `sandbox-extensions`,
`rlm-repo-fanout`) that all use exactly this pattern.

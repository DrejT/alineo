---
"@alineo-labs/sqlite": patch
---

`SQLiteAdapter` now sets `PRAGMA synchronous = FULL` explicitly alongside WAL. Bun's bundled
SQLite already defaults to `FULL`, so nothing changes there — but the setting was inherited from
whichever SQLite build loaded the file, and under WAL a `NORMAL` default can drop the most recent
commits on power loss. `resume()` replays from this ledger, so a lost commit is a lost step.

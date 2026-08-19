---
"@alineo-labs/sqlite": patch
---

Fix a race in `SQLiteAdapter`'s constructor where `mkdirSync` on an already-existing parent
directory (e.g. two adapters opened concurrently against the same DB dir) threw `EEXIST`
instead of being treated as a no-op.

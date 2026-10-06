---
"@alineo-labs/sqlite-memory": minor
---

Add `SQLiteSemanticMemoryProvider.listRecent(ref, limit)` — the newest `limit` facts, newest first,
read through a new `(scope, remembered_at)` index — and export `loadSqliteVec(db)`, the exact way the
provider loads the `sqlite-vec` extension.

`listRecent` is for callers that page through a resource's facts: `listAll()` deserializes every
fact the resource ever remembered, which is right for compaction and `Memory.fork()` and wrong for
"show me the last ten". `loadSqliteVec` is for anything else that has to open one of these
databases (a backup tool, say — a `vec0` virtual table can't be read or `VACUUM`ed without its
module), so there is one way to load the extension rather than a copy per consumer. The index is
created idempotently on open.

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

`SQLiteWorkingMemoryProvider` also gains `listPage(ref, { after, limit })`, walking the existing
`(scope, key)` primary-key index, and both providers now implement the matching optional
capabilities from `@alineo-labs/memory`.

`SQLiteSemanticMemoryProvider` now checks the `vec0` index's width against the table on disk, and
throws a clear error — before writing anything — when an embedding model of a different size is
used against an existing store. Previously `CREATE VIRTUAL TABLE IF NOT EXISTS` silently no-op'd
against the old table, the provider reported the index as usable, and the first insert failed in
the native extension after the fact's metadata row was already written.

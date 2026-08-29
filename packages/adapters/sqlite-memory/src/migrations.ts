export const WORKING_MEMORY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_working_memory (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

/**
 * `rowid_key` is a plain autoincrementing integer, separate from the public `id` (a UUID) —
 * it exists purely so a row here can be joined to its matching row in the `vec0` virtual
 * table created lazily by `SQLiteSemanticMemoryProvider` (`vec0` keys rows by integer
 * `rowid`, and `id` isn't guaranteed to be representable as one). `vector` (JSON-encoded)
 * stays on this table even when the `vec0` index is active — it's the fallback path used if
 * the `sqlite-vec` native extension fails to load on a given platform.
 */
export const SEMANTIC_MEMORY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_semantic_memory (
  rowid_key          INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT    NOT NULL UNIQUE,
  scope              TEXT    NOT NULL,
  content            TEXT    NOT NULL,
  vector             TEXT    NOT NULL,
  source_sandbox_id  TEXT,
  source_entry_index INTEGER,
  remembered_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS alineo_semantic_memory_scope ON alineo_semantic_memory(scope);
`;

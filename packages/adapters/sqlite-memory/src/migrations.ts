export const WORKING_MEMORY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_working_memory (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

export const SEMANTIC_MEMORY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_semantic_memory (
  id                 TEXT    PRIMARY KEY,
  scope              TEXT    NOT NULL,
  content            TEXT    NOT NULL,
  vector             TEXT    NOT NULL,
  source_sandbox_id  TEXT,
  source_entry_index INTEGER,
  remembered_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS alineo_semantic_memory_scope ON alineo_semantic_memory(scope);
`;

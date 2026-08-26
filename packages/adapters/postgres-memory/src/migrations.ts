/**
 * `team_id` is a plain nullable column, not the primary scoping key (`scope`, same
 * resourceId[:teamId] composite every provider in this package family uses) — it exists
 * purely so the row-level security policies below have something to check. A row with
 * `team_id IS NULL` (an untenanted resource) is visible to every session; a row with a
 * `team_id` is visible only when the connection has `SET LOCAL app.team_id` to a matching
 * value first — which `PostgresWorkingMemoryProvider`/`PostgresSemanticMemoryProvider` do
 * automatically, per call, via a wrapping transaction (see `withTeamContext` in `shared.ts`).
 *
 * `FORCE ROW LEVEL SECURITY` matters here specifically because the same role that runs these
 * migrations (typically the table owner) is also the role the app connects as — Postgres
 * exempts the table owner from RLS by default, which would make the policy a no-op for the
 * exact role most likely to be running application queries. `FORCE` closes that gap.
 *
 * `CREATE POLICY` has no `IF NOT EXISTS` in any Postgres version — the `DO $$ ... EXCEPTION
 * WHEN duplicate_object` wrapper is the standard idiom for making it re-runnable, matching
 * this migration file's `CREATE TABLE IF NOT EXISTS` idempotency everywhere else.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_working_memory (
  scope   TEXT  NOT NULL,
  team_id TEXT,
  key     TEXT  NOT NULL,
  value   JSONB NOT NULL,
  PRIMARY KEY (scope, key)
);

ALTER TABLE alineo_working_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE alineo_working_memory FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY alineo_working_memory_team_isolation ON alineo_working_memory
    FOR ALL
    USING (team_id IS NULL OR team_id = current_setting('app.team_id', true))
    WITH CHECK (team_id IS NULL OR team_id = current_setting('app.team_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS alineo_semantic_memory (
  id                 TEXT              PRIMARY KEY,
  scope              TEXT              NOT NULL,
  team_id            TEXT,
  content            TEXT              NOT NULL,
  vector             DOUBLE PRECISION[] NOT NULL,
  source_sandbox_id  TEXT,
  source_entry_index INTEGER,
  remembered_at      BIGINT            NOT NULL
);

CREATE INDEX IF NOT EXISTS alineo_semantic_memory_scope ON alineo_semantic_memory(scope);

ALTER TABLE alineo_semantic_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE alineo_semantic_memory FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY alineo_semantic_memory_team_isolation ON alineo_semantic_memory
    FOR ALL
    USING (team_id IS NULL OR team_id = current_setting('app.team_id', true))
    WITH CHECK (team_id IS NULL OR team_id = current_setting('app.team_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

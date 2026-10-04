export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_events (
  id          BIGSERIAL   PRIMARY KEY,
  sandbox_id  TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  step_idx    INTEGER     NOT NULL,
  branch      INTEGER,
  event       TEXT        NOT NULL,
  payload     JSONB,
  error       TEXT,
  ts          BIGINT      NOT NULL
);

-- Replaces the two single-column indexes below (dropped for an existing database in
-- adapter.ts's connect()) -- see packages/adapters/sqlite/src/migrations.ts's matching
-- comment for why 'ts' (not 'id') stays the primary sort key, with 'id' only as a tie-breaker.
CREATE INDEX IF NOT EXISTS alineo_events_name_sandbox_ts
  ON alineo_events(name, sandbox_id, ts, id);

CREATE TABLE IF NOT EXISTS alineo_environments (
  name        TEXT    PRIMARY KEY,
  snapshot_id TEXT    NOT NULL,
  image       TEXT    NOT NULL,
  built_at    BIGINT  NOT NULL
);
`;

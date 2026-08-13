export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_events (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  sandbox_id  TEXT     NOT NULL,
  name        TEXT     NOT NULL,
  step_idx    INTEGER  NOT NULL,
  branch      INTEGER,
  event       TEXT     NOT NULL,
  payload     TEXT,
  error       TEXT,
  ts          INTEGER  NOT NULL
);

CREATE INDEX IF NOT EXISTS alineo_events_sandbox_id ON alineo_events(sandbox_id);
CREATE INDEX IF NOT EXISTS alineo_events_name ON alineo_events(name);

CREATE TABLE IF NOT EXISTS alineo_environments (
  name        TEXT    PRIMARY KEY,
  snapshot_id TEXT    NOT NULL,
  image       TEXT    NOT NULL,
  built_at    INTEGER NOT NULL
);
`;

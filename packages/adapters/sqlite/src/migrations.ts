export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS alineo_events (
  -- No AUTOINCREMENT: this is an append-only log, so rowid reuse after a delete is not a
  -- concern worth paying a sqlite_sequence write on every insert for (foundation-packages.md
  -- Phase 3). Only affects freshly-created databases -- SQLite can't retroactively strip
  -- AUTOINCREMENT from an existing table's schema, and that's a one-time insert-cost
  -- difference, not a correctness issue, so an existing database is left as-is.
  id          INTEGER  PRIMARY KEY,
  sandbox_id  TEXT     NOT NULL,
  name        TEXT     NOT NULL,
  step_idx    INTEGER  NOT NULL,
  branch      INTEGER,
  event       TEXT     NOT NULL,
  payload     TEXT,
  error       TEXT,
  ts          INTEGER  NOT NULL
);

-- Replaces the two single-column indexes below (dropped in adapter.ts's connect(), for
-- existing databases) -- every hot read filters on (name, sandbox_id) and orders by ts, which
-- this one composite index now covers end to end instead of SQLite picking one single-column
-- index, filtering the rest, then sorting ts separately. 'id' is a tie-breaker only (two
-- entries can share a ts) -- the primary sort key stays 'ts', not 'id': callers can append
-- entries with an out-of-order ts (see adapter.test.ts's "returns entries in ascending
-- timestamp order", which deliberately appends ts 2000 then ts 1000 and expects ts order back),
-- so 'id' is not a safe substitute for 'ts' the way foundation-packages.md's original proposal
-- assumed -- insertion order and timestamp order are not guaranteed to agree.
CREATE INDEX IF NOT EXISTS alineo_events_name_sandbox_ts
  ON alineo_events(name, sandbox_id, ts, id);

CREATE TABLE IF NOT EXISTS alineo_environments (
  name        TEXT    PRIMARY KEY,
  snapshot_id TEXT    NOT NULL,
  image       TEXT    NOT NULL,
  built_at    INTEGER NOT NULL
);
`;

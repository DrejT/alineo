/**
 * alineod's durable state — plain `bun:sqlite`, three tables (research/daemon.md §4).
 *
 * `ledger` is the source of truth (append-only); `agents` and `handles` are caches folded
 * from it by projection.ts and fully rebuildable. `seq` doubles as the SSE `Last-Event-ID`
 * marker.
 *
 * Deliberately NOT `@alineo-labs/sqlite`'s `IStorageAdapter`: that schema is shaped around the
 * per-sandbox substrate ledger. This is the swarm-shape ledger — a different model. Same call
 * made by apps/telemetry for the same reason.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "@alineo-labs/logger";
import { DB_PATH } from "../../config";
import { migrateEventNames } from "./migrate-event-names";
import { migrateAgentSpecs } from "./migrate-agent-specs";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
// Pinned rather than inherited: Bun's bundled SQLite defaults to FULL, but the build default is
// what decides it (a system SQLite, or NORMAL under WAL, can drop the last commits on power
// loss). A ledger event is only "committed" if it survives that.
db.exec("PRAGMA synchronous = FULL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS ledger (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT    NOT NULL,
  agent_id  TEXT,                         -- null for run-level events
  ts        INTEGER NOT NULL,             -- epoch ms
  event     TEXT    NOT NULL,             -- alineod agent_* event, or a forwarded harness event type
  payload   TEXT                          -- JSON
);
CREATE INDEX IF NOT EXISTS ledger_run ON ledger (run_id, seq);
CREATE INDEX IF NOT EXISTS ledger_agent_event ON ledger (agent_id, event, seq);

CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  run_id          TEXT    NOT NULL,
  parent_agent_id TEXT,
  depth           INTEGER NOT NULL,
  spawn_index     INTEGER NOT NULL,
  state           TEXT    NOT NULL,       -- provisioning|running|spawning|paused|done|failed|aborted|lost
  spec_name       TEXT    NOT NULL,
  spec_json       TEXT    NOT NULL,
  sandbox_id      TEXT,
  -- Budget alineod passes to parent.spawn({ spawnDepth, maxAgents }) when THIS agent spawns.
  -- alineod owns this accounting because it drives .spawn() out-of-process -- the SDK's
  -- ALINEO_SPAWN_DEPTH env mechanism only works for in-sandbox "alineo spawn". Root gets it
  -- from its spec / the run budget; each child gets parent - 1. NULL means spawning disabled.
  spawn_budget      INTEGER,
  max_agents_budget INTEGER,
  -- Persisted so a spawn that's still pre-fork (waiting on waitFor, or -- for a root --
  -- still inside Alineo.start()) at crash time can be RETRIED on rehydrate instead of just
  -- marked lost. Before this, that intent only ever lived in the dead process's closure.
  wait_for        TEXT,                   -- JSON array of agentIds, or NULL
  prompt          TEXT,
  -- State before the most recent pause, restored on resume.
  paused_from     TEXT,
  -- Who paused it: operator (the target of a pause) or cascade (a descendant of one). NULL when not paused.
  paused_by       TEXT,
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  outcome         TEXT                    -- success|failed|aborted|budget-exceeded|lost
);
CREATE INDEX IF NOT EXISTS agents_run ON agents (run_id);
CREATE INDEX IF NOT EXISTS agents_parent ON agents (parent_agent_id);

CREATE TABLE IF NOT EXISTS handles (
  agent_id   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  state      TEXT NOT NULL,               -- pending|settled
  outcome    TEXT,
  result_ref TEXT,                        -- currently a local path; planned: fs://<agentId>/<path> (D-d)
  settled_at INTEGER
);

-- D-f: client-supplied idempotency keys for POST /runs/:id/agents. Not ledger-backed (it's
-- request-dedup bookkeeping, not swarm history) -- rebuild() never touches this table.
CREATE TABLE IF NOT EXISTS spawn_idempotency (
  run_id   TEXT NOT NULL,
  key      TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
`);

/** Additive column migrations — `ALTER TABLE ADD COLUMN` throws if the column already exists. */
for (const alter of [
  "ALTER TABLE agents ADD COLUMN spawn_budget INTEGER",
  "ALTER TABLE agents ADD COLUMN max_agents_budget INTEGER",
  "ALTER TABLE agents ADD COLUMN wait_for TEXT",
  "ALTER TABLE agents ADD COLUMN prompt TEXT",
  "ALTER TABLE agents ADD COLUMN paused_from TEXT",
  "ALTER TABLE agents ADD COLUMN paused_by TEXT",
]) {
  try {
    db.exec(alter);
  } catch {
    /* column already present */
  }
}

// Tier 2 notifications (research/tier-1-2-plan.md #5) — both are ledger projections like
// agents/handles: rebuilt from notify_registered / inbox_* events, never written directly.
db.exec(`
CREATE TABLE IF NOT EXISTS notify_subscriptions (
  subscriber_id TEXT NOT NULL,
  on_agent_id   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  wake          INTEGER NOT NULL DEFAULT 0,  -- start a turn on an idle subscriber instead of queueing
  PRIMARY KEY (subscriber_id, on_agent_id)
);
CREATE INDEX IF NOT EXISTS notify_on ON notify_subscriptions (on_agent_id);

CREATE TABLE IF NOT EXISTS inbox (
  seq            INTEGER PRIMARY KEY,         -- the ledger seq of its inbox_queued event
  run_id         TEXT NOT NULL,
  agent_id       TEXT NOT NULL,               -- the recipient
  kind           TEXT NOT NULL,               -- notification | steer
  about_agent_id TEXT,
  about_spec     TEXT,
  outcome        TEXT,
  result_ref     TEXT,
  excerpt        TEXT,
  again          INTEGER NOT NULL DEFAULT 0,
  text           TEXT,                        -- steer: the message to deliver verbatim
  state          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | dropped
  delivered_as   TEXT,                        -- steer | turn | prompt, or the drop reason
  settled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_agent ON inbox (agent_id, state);
`);

// Rename the `event` column to the namespaced names. Runs at boot, after the tables exist
// and before anything reads them — a projection folding on the new names would silently skip
// every old row, which presents as an empty swarm rather than as an error.
const renamed = migrateEventNames(db);
if (renamed > 0) {
  getLogger("alineod").info("migrated ledger event names", { rows: renamed });
}

// And the spec each `agent.spawned` row carries. Same moment, same reason: `rehydrate()`
// folds that spec back out and validates it, so one still spelling `cli` fails every
// reattach and marks each still-running agent `lost` on the first boot after the upgrade.
const respecced = migrateAgentSpecs(db);
if (respecced > 0) {
  getLogger("alineod").info("migrated stored agent spec fields", { rows: respecced });
}

export interface LedgerRow {
  seq: number;
  run_id: string;
  agent_id: string | null;
  ts: number;
  event: string;
  payload: string | null;
}

const insertLedger = db.query<
  { seq: number },
  [string, string | null, number, string, string | null]
>(`INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq`);

/** Append one event and return its `seq`. Callers should also run projection.apply() on the row. */
export function appendRow(
  runId: string,
  agentId: string | null,
  event: string,
  payload: unknown,
): LedgerRow {
  const ts = Date.now();
  const payloadJson = payload === undefined ? null : JSON.stringify(payload);
  const { seq } = insertLedger.get(runId, agentId, ts, event, payloadJson)!;
  return { seq, run_id: runId, agent_id: agentId, ts, event, payload: payloadJson };
}

const selectSince = db.query<LedgerRow, [string, number]>(
  `SELECT seq, run_id, agent_id, ts, event, payload FROM ledger
   WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
);

export function readLedgerSince(runId: string, afterSeq: number): LedgerRow[] {
  return selectSince.all(runId, afterSeq);
}

const selectRunLedger = db.query<LedgerRow, [string]>(
  `SELECT seq, run_id, agent_id, ts, event, payload FROM ledger WHERE run_id = ? ORDER BY seq ASC`,
);

export function readRunLedger(runId: string): LedgerRow[] {
  return selectRunLedger.all(runId);
}

const selectAgentEvents = db.query<LedgerRow, [string, string]>(
  `SELECT seq, run_id, agent_id, ts, event, payload FROM ledger
   WHERE agent_id = ? AND event = ? ORDER BY seq ASC`,
);

/** One agent's rows of a single event type, oldest first (e.g. every `agent_end` it emitted). */
export function readAgentEvents(agentId: string, event: string): LedgerRow[] {
  return selectAgentEvents.all(agentId, event);
}

/** Replay the entire ledger, oldest first — used once at boot to rebuild the projections. */
const selectAllLedger = db.query<LedgerRow, []>(
  `SELECT seq, run_id, agent_id, ts, event, payload FROM ledger ORDER BY seq ASC`,
);

export function readAllLedger(): LedgerRow[] {
  return selectAllLedger.all();
}

// ── spawn idempotency (D-f) ──────────────────────────────────────────────────

const insertIdempotent = db.query<unknown, [string, string, string]>(
  `INSERT INTO spawn_idempotency (run_id, key, agent_id) VALUES (?, ?, ?)
   ON CONFLICT (run_id, key) DO NOTHING`,
);
const selectIdempotent = db.query<{ agent_id: string }, [string, string]>(
  `SELECT agent_id FROM spawn_idempotency WHERE run_id = ? AND key = ?`,
);

export function recordIdempotent(runId: string, key: string, agentId: string): void {
  insertIdempotent.run(runId, key, agentId);
}

export function findIdempotent(runId: string, key: string): string | null {
  return selectIdempotent.get(runId, key)?.agent_id ?? null;
}

/**
 * M1.1's fault-harness worker: a real, separate OS process that hammers a real sqlite file on
 * disk with the same two durability pragmas `state/db.ts` pins (`journal_mode = WAL`,
 * `synchronous = FULL`), so the parent test can `kill -9` it mid-burst and check what a real
 * process death — not the in-process `simulateCrashAndRehydrate()` every other fault-harness
 * scenario uses — actually leaves on disk. That in-process helper only drops alineod's own
 * JS-level caches in the *same* process; it can't exercise "does synchronous=FULL really get an
 * acknowledged write through fsync before a kill", which is the one thing this chunk is for.
 *
 * The `ledger` table here mirrors `state/db.ts`'s real one (same columns) rather than importing
 * that module directly: importing it would also pull in the full daemon config, its migrations,
 * and the `agents`/`handles` tables — real for alineod, irrelevant to the property under test,
 * and a source of unrelated failures in a bare child process with no HTTP app around it.
 *
 * Protocol with the parent (fault-harness.test.ts): print one line per row, the instant the
 * insert's `.run()` call returns — i.e. after SQLite has already fsynced it under
 * `synchronous = FULL`. The parent only trusts a row as "acknowledged" once it has actually read
 * that line, so a line still sitting unread in the pipe at kill time is correctly NOT counted —
 * the invariant under test is "no acknowledged write is lost", not "no write in flight survives".
 */
import { Database } from "bun:sqlite";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: write-burst-worker.ts <db-path>");

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = FULL;");
db.exec(`
CREATE TABLE IF NOT EXISTS ledger (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT    NOT NULL,
  agent_id  TEXT,
  ts        INTEGER NOT NULL,
  event     TEXT    NOT NULL,
  payload   TEXT
);
`);

const insert = db.query(
  "INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES ($runId, NULL, $ts, $event, $payload) RETURNING seq;",
);

for (let i = 0; ; i++) {
  const row = insert.get({
    $runId: "write-burst",
    $ts: Date.now(),
    $event: "fault.write_burst",
    $payload: JSON.stringify({ i }),
  }) as { seq: number };
  // One line per acknowledged row, flushed at once — this is the parent's only source of truth
  // for what was actually committed before it sends SIGKILL.
  process.stdout.write(`${row.seq}\n`);
}

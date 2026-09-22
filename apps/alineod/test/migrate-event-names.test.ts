/**
 * The migration round-trip gate: a database written before the rename must, after migrating,
 * fold to the same projection it produced before.
 *
 * Built on a standalone `bun:sqlite` rather than the app's own `db`, because the app's
 * migration already ran at import. What matters is the transformation, and running it against
 * a hand-seeded pre-rename database is the only way to exercise rows that no longer exist.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eventRenames, migrateEventNames } from "../src/state/migrate-event-names";

function preRenameDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ledger (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT NOT NULL,
    agent_id TEXT,
    ts       INTEGER NOT NULL,
    event    TEXT NOT NULL,
    payload  TEXT
  )`);
  return db;
}

function seed(db: Database, events: string[]): void {
  const insert = db.query(
    "INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?, ?, ?, ?, ?)",
  );
  events.forEach((event, i) => insert.run("r_1", "a_1", 1000 + i, event, "{}"));
}

const names = (db: Database) =>
  db
    .query<{ event: string }, []>("SELECT event FROM ledger ORDER BY seq")
    .all()
    .map((r) => r.event);

describe("migrateEventNames", () => {
  test("renames a full pre-rename run, alineod's events and forwarded harness ones alike", () => {
    const db = preRenameDb();
    seed(db, [
      "run_started",
      "agent_spawned",
      "agent_provisioned",
      "agent_start",
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_end",
      "agent_end",
      "handle_settled",
      "agent_ended",
    ]);

    expect(migrateEventNames(db)).toBe(11);
    expect(names(db)).toEqual([
      "run.started",
      "agent.spawned",
      "agent.provisioned",
      "session.started",
      "turn.started",
      "tool.started",
      "tool.ended",
      "turn.ended",
      "session.ended",
      "handle.settled",
      "agent.ended",
    ]);
  });

  test("is a no-op the second time — which is what lets it run at every boot", () => {
    // There is no schema_version table anywhere in this repo. Idempotence is the mechanism.
    const db = preRenameDb();
    seed(db, ["agent_spawned", "agent_ended"]);
    expect(migrateEventNames(db)).toBe(2);
    expect(migrateEventNames(db)).toBe(0);
    expect(names(db)).toEqual(["agent.spawned", "agent.ended"]);
  });

  test("is a no-op on a database that was always post-rename", () => {
    const db = preRenameDb();
    seed(db, ["agent.spawned", "agent.ended"]);
    expect(migrateEventNames(db)).toBe(0);
  });

  test("leaves rows it has no mapping for alone rather than nulling them", () => {
    const db = preRenameDb();
    seed(db, ["agent_spawned", "something_nobody_defined"]);
    migrateEventNames(db);
    // The CASE has an ELSE; without it every unmatched row would be rewritten to NULL and the
    // projection would silently lose them.
    expect(names(db)).toEqual(["agent.spawned", "something_nobody_defined"]);
  });

  test("preserves seq, so Last-Event-ID keeps meaning the same thing", () => {
    // An SSE client reconnecting across the migration passes the seq it last saw. Renaming by
    // delete-and-reinsert would renumber every row and silently replay or skip history.
    const db = preRenameDb();
    seed(db, ["agent_spawned", "turn_start", "agent_ended"]);
    const before = db
      .query<{ seq: number; ts: number }, []>("SELECT seq, ts FROM ledger ORDER BY seq")
      .all();
    migrateEventNames(db);
    const after = db
      .query<{ seq: number; ts: number }, []>("SELECT seq, ts FROM ledger ORDER BY seq")
      .all();
    expect(after).toEqual(before);
  });

  test("touches only the event column", () => {
    const db = preRenameDb();
    db.query("INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?,?,?,?,?)").run(
      "r_1",
      "a_1",
      42,
      "agent_ended",
      JSON.stringify({ outcome: "success" }),
    );
    migrateEventNames(db);
    const row = db.query<{ payload: string; agent_id: string }, []>("SELECT * FROM ledger").get()!;
    expect(JSON.parse(row.payload)).toEqual({ outcome: "success" });
    expect(row.agent_id).toBe("a_1");
  });

  test("does not rewrite substrate or workflow names, which this store never held", () => {
    // They belong to the SDK's own ledger. Mapping them here would rewrite rows that cannot
    // exist, and would be wrong about which store owns them if they somehow did.
    const olds = eventRenames().map(([old]) => old);
    for (const name of ["sandbox_created", "exec_complete", "checkpoint", "snapshot"]) {
      expect(olds).not.toContain(name);
    }
  });

  test("maps run_started to the swarm run, not the workflow one", () => {
    // The shared rename table leaves this unmapped on purpose: it meant two different events.
    expect(eventRenames()).toContainEqual(["run_started", "run.started"]);
  });
});

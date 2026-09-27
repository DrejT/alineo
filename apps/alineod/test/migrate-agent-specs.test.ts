/**
 * The other half of the rename a pre-upgrade database needs: the `AgentSpec` stored inside
 * every `agent.spawned` payload.
 *
 * Without it, `rehydrate()` folds a spec still spelling `cli` out of the ledger, hands it to
 * `Alineo.reattach()`, and `validateAgentSpec` rejects it — so the first boot after the
 * upgrade marks every still-running agent `lost`. That is what this was written against,
 * after seeing it happen to a copy of a real database.
 *
 * Standalone `bun:sqlite`, for the same reason as `migrate-event-names.test.ts`: the app's
 * own migration has already run by import time, and the rows that matter no longer exist.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAgentSpecs } from "../src/state/migrate-agent-specs";

function ledgerDb(): Database {
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

/** One `agent.spawned` row, shaped the way `spawn.ts` writes it. */
function spawned(db: Database, spec: Record<string, unknown>, event = "agent.spawned"): void {
  db.query("INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?,?,?,?,?)").run(
    "r_1",
    "a_1",
    1000,
    event,
    JSON.stringify({
      agentId: "a_1",
      parentAgentId: null,
      runId: "r_1",
      specName: spec.name,
      specJson: JSON.stringify(spec),
    }),
  );
}

function specs(db: Database): Record<string, unknown>[] {
  return db
    .query<{ payload: string }, []>("SELECT payload FROM ledger ORDER BY seq")
    .all()
    .map((r) => JSON.parse(JSON.parse(r.payload).specJson as string) as Record<string, unknown>);
}

describe("migrateAgentSpecs", () => {
  test("renames cli and cliVersion in a stored spec", () => {
    const db = ledgerDb();
    spawned(db, { name: "coordinator", cli: "pi", cliVersion: "1.2.3", model: "m" });

    expect(migrateAgentSpecs(db)).toBe(1);
    expect(specs(db)[0]).toEqual({
      name: "coordinator",
      model: "m",
      harness: "pi",
      harnessVersion: "1.2.3",
    });
  });

  test("leaves specJson a JSON-encoded string, not a nested object", () => {
    // The whole reason this is JavaScript and not one `json_set`: SQLite's JSON functions
    // carry a subtype that turns the rewritten string back into an object, and `rehydrate()`
    // then binds an object where the projection expects text. `CAST(… AS TEXT)` does not
    // strip that subtype on SQLite 3.51.
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "pi" });
    migrateAgentSpecs(db);
    const payload = JSON.parse(
      db.query<{ payload: string }, []>("SELECT payload FROM ledger").get()!.payload,
    );
    expect(typeof payload.specJson).toBe("string");
  });

  test("is a no-op the second time — which is what lets it run at every boot", () => {
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "pi" });
    expect(migrateAgentSpecs(db)).toBe(1);
    expect(migrateAgentSpecs(db)).toBe(0);
  });

  test("is a no-op on a database that was always post-rename", () => {
    const db = ledgerDb();
    spawned(db, { name: "a", harness: "pi" });
    expect(migrateAgentSpecs(db)).toBe(0);
    expect(specs(db)[0]).toEqual({ name: "a", harness: "pi" });
  });

  test("drops the stale field without overwriting a new one that is already set", () => {
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "codex", harness: "pi" });
    expect(migrateAgentSpecs(db)).toBe(1);
    expect(specs(db)[0]).toEqual({ name: "a", harness: "pi" });
  });

  test("preserves seq, so Last-Event-ID keeps meaning the same thing", () => {
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "pi" });
    spawned(db, { name: "b", cli: "pi" });
    const before = db
      .query<{ seq: number; ts: number; event: string }, []>(
        "SELECT seq, ts, event FROM ledger ORDER BY seq",
      )
      .all();
    migrateAgentSpecs(db);
    expect(
      db
        .query<{ seq: number; ts: number; event: string }, []>(
          "SELECT seq, ts, event FROM ledger ORDER BY seq",
        )
        .all(),
    ).toEqual(before);
  });

  test("leaves every other field of the payload alone", () => {
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "pi" });
    migrateAgentSpecs(db);
    const payload = JSON.parse(
      db.query<{ payload: string }, []>("SELECT payload FROM ledger").get()!.payload,
    );
    expect(payload.agentId).toBe("a_1");
    expect(payload.runId).toBe("r_1");
    expect(payload.specName).toBe("a");
  });

  test("does not depend on the event-name migration having run first", () => {
    // Both run at import in db.ts, in that order — but selecting on the stale field rather
    // than on `event = 'agent.spawned'` means this one cannot be broken by that changing.
    const db = ledgerDb();
    spawned(db, { name: "a", cli: "pi" }, "agent_spawned");
    expect(migrateAgentSpecs(db)).toBe(1);
    expect(specs(db)[0]).toEqual({ name: "a", harness: "pi" });
  });

  test("skips a payload whose specJson is not parseable rather than throwing", () => {
    const db = ledgerDb();
    db.query("INSERT INTO ledger (run_id, agent_id, ts, event, payload) VALUES (?,?,?,?,?)").run(
      "r_1",
      "a_1",
      1,
      "agent.spawned",
      JSON.stringify({ specJson: "{not json" }),
    );
    expect(migrateAgentSpecs(db)).toBe(0);
  });
});

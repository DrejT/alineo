import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQLiteEngineLedger } from "../src/engine-ledger.ts";

describe("SQLiteEngineLedger", () => {
  let db: SQLiteEngineLedger;

  beforeEach(() => {
    db = new SQLiteEngineLedger(":memory:");
  });

  afterEach(async () => {
    await db.close();
  });

  it("assigns an increasing seq on append", async () => {
    const a = await db.append({ scope: "run-1", event: "a", ts: 1 });
    const b = await db.append({ scope: "run-1", event: "b", ts: 2 });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("round-trips a JSON payload", async () => {
    const row = await db.append({ scope: "run-1", event: "a", ts: 1, payload: { x: 42 } });
    expect(row.payload).toEqual({ x: 42 });
  });

  it("readByScope returns only that scope's rows, in seq order", async () => {
    await db.append({ scope: "run-1", event: "a", ts: 1 });
    await db.append({ scope: "run-2", event: "a", ts: 2 });
    await db.append({ scope: "run-1", event: "b", ts: 3 });
    const rows = await db.readByScope("run-1");
    expect(rows.map((r) => r.event)).toEqual(["a", "b"]);
  });

  it("readByScope with afterSeq excludes rows up to and including that seq", async () => {
    const first = await db.append({ scope: "run-1", event: "a", ts: 1 });
    await db.append({ scope: "run-1", event: "b", ts: 2 });
    const rows = await db.readByScope("run-1", { afterSeq: first.seq });
    expect(rows.map((r) => r.event)).toEqual(["b"]);
  });

  it("readBySubScope returns only that subScope's rows across scopes", async () => {
    await db.append({ scope: "run-1", subScope: "agent-1", event: "a", ts: 1 });
    await db.append({ scope: "run-1", subScope: "agent-2", event: "a", ts: 2 });
    await db.append({ scope: "run-2", subScope: "agent-1", event: "b", ts: 3 });
    const rows = await db.readBySubScope("agent-1");
    expect(rows.map((r) => r.event)).toEqual(["a", "b"]);
  });

  it("readBySubScope filters by event when given", async () => {
    await db.append({ scope: "run-1", subScope: "agent-1", event: "a", ts: 1 });
    await db.append({ scope: "run-1", subScope: "agent-1", event: "b", ts: 2 });
    const rows = await db.readBySubScope("agent-1", "b");
    expect(rows.map((r) => r.event)).toEqual(["b"]);
  });

  it("a scope-level entry (no subScope) is never returned by readBySubScope", async () => {
    await db.append({ scope: "run-1", event: "run-level", ts: 1 });
    const rows = await db.readBySubScope("run-1");
    expect(rows).toHaveLength(0);
  });

  it("readAll returns every entry across every scope, in seq order", async () => {
    await db.append({ scope: "run-1", event: "a", ts: 1 });
    await db.append({ scope: "run-2", event: "b", ts: 2 });
    const rows = await db.readAll();
    expect(rows.map((r) => r.event)).toEqual(["a", "b"]);
  });

  it("survives a reopen against the same file (durability)", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(tmpdir(), `engine-ledger-test-${crypto.randomUUID()}.db`);
    const first = new SQLiteEngineLedger(path);
    await first.append({ scope: "run-1", event: "a", ts: 1 });
    await first.close();

    const second = new SQLiteEngineLedger(path);
    const rows = await second.readAll();
    expect(rows).toHaveLength(1);
    await second.close();

    const { rmSync } = await import("node:fs");
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  });
});

describe("SQLiteEngineLedger bound to a pre-existing, differently-named table", () => {
  // Mirrors alineod's actual `ledger` table (apps/alineod/src/state/db.ts) exactly, including
  // its own column names — this is the shape 3.1b actually binds onto, not the default one.
  let raw: Database;
  let db: SQLiteEngineLedger;

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE ledger (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id   TEXT    NOT NULL,
        agent_id TEXT,
        ts       INTEGER NOT NULL,
        event    TEXT    NOT NULL,
        payload  TEXT
      );
    `);
    db = new SQLiteEngineLedger(raw, {
      table: "ledger",
      scopeColumn: "run_id",
      subScopeColumn: "agent_id",
    });
  });

  afterEach(async () => {
    await db.close();
    raw.close();
  });

  it("does not create or touch any other table (no ENGINE_LEDGER_MIGRATION_SQL run)", () => {
    const tables = raw
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    // sqlite_sequence is SQLite's own side effect of the fixture's AUTOINCREMENT column
    // (mirroring alineod's real schema), not something the constructor created.
    expect(tables.filter((t) => t !== "sqlite_sequence")).toEqual(["ledger"]);
  });

  it("writes and reads through the pre-existing ledger table's own columns", async () => {
    await db.append({ scope: "run-1", subScope: "agent-1", event: "agent.spawned", ts: 1 });
    const raw_row = raw
      .query<{ run_id: string; agent_id: string }, []>("SELECT run_id, agent_id FROM ledger")
      .get()!;
    expect(raw_row).toEqual({ run_id: "run-1", agent_id: "agent-1" });

    const rows = await db.readByScope("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].subScope).toBe("agent-1");
  });

  it("close() does not close the shared connection", async () => {
    await db.append({ scope: "run-1", event: "a", ts: 1 });
    await db.close();
    // Still usable — a real close() would make this throw.
    expect(raw.query("SELECT 1").get()).toBeTruthy();
  });
});

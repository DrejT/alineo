/**
 * The migration round-trip gate for the SDK's own ledger.
 *
 * A database written before the namespacing must, after migrating, read back the same
 * session details it did before. `getSandboxDetails` aggregates on literal event names
 * (`event = 'sandbox.created'`, `COUNT(... 'exec.completed')`), so an unmigrated row does not
 * error — it silently disappears from the result. That is the failure this test exists to
 * catch, and it is why the migration runs in `connect()` before any read.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SandboxStatus } from "@alineo-labs/core";
import { renameEventsStatement } from "@alineo-labs/ledger";
import { MIGRATION_SQL } from "../src/migrations.ts";
import { SQLiteAdapter } from "../src/adapter.ts";

/** A pre-namespacing database, written straight through the driver. */
function seedPreRename(path: string): void {
  const db = new Database(path, { create: true });
  db.run(MIGRATION_SQL);
  const insert = db.prepare(
    `INSERT INTO alineo_events (sandbox_id, name, step_idx, branch, event, payload, error, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows: [string, string, number, null, string, string | null, null, number][] = [
    ["sb-1", "sess", -1, null, "sandbox_created", JSON.stringify({ runId: "r-1" }), null, 1000],
    ["sb-1", "sess", 0, null, "exec_start", null, null, 1001],
    ["sb-1", "sess", 0, null, "exec_event", JSON.stringify({ text: "hi" }), null, 1002],
    ["sb-1", "sess", 0, null, "exec_complete", JSON.stringify({ exitCode: 0 }), null, 1003],
    [
      "sb-1",
      "sess",
      1,
      null,
      "checkpoint_created",
      JSON.stringify({ snapshotId: "s1" }),
      null,
      1004,
    ],
    ["sb-1", "sess", -1, null, "sandbox_closed", null, null, 1005],
  ];
  for (const row of rows) insert.run(...row);
  db.close();
}

const eventsOf = (path: string) => {
  const db = new Database(path);
  const names = db
    .query<{ event: string }, []>("SELECT event FROM alineo_events ORDER BY id")
    .all()
    .map((r) => r.event);
  db.close();
  return names;
};

function tmpPath(): string {
  return `${process.env.TMPDIR ?? "/tmp"}/alineo-rename-${crypto.randomUUID()}.db`;
}

describe("the event-name migration", () => {
  it("renames a pre-namespacing database on connect()", async () => {
    const path = tmpPath();
    seedPreRename(path);

    const adapter = new SQLiteAdapter(path);
    await adapter.connect();
    await adapter.close();

    expect(eventsOf(path)).toEqual([
      "sandbox.created",
      "exec.started",
      "exec.output",
      "exec.completed",
      "sandbox.checkpoint_created",
      "sandbox.closed",
    ]);
  });

  it("reads the same session details after migrating as it would have before", async () => {
    // The real regression risk: getSandboxDetails aggregates on literal names, so an
    // unmigrated row is not an error — the session just stops existing.
    const path = tmpPath();
    seedPreRename(path);

    const adapter = new SQLiteAdapter(path);
    await adapter.connect();
    const details = await adapter.getSandboxDetails("sess", "sb-1");
    await adapter.close();

    expect(details).toMatchObject({
      name: "sess",
      sandboxId: "sb-1",
      status: SandboxStatus.Completed,
      startedAt: 1000,
      completedAt: 1005,
      execCount: 1,
      runId: "r-1",
    });
  });

  it("finds the last checkpoint, which resume() depends on", async () => {
    // `lastCheckpoint` filters on `event = 'sandbox.checkpoint_created'` literally. Before
    // the migration this returns null on an old database, and resume() silently restores
    // nothing rather than reporting a problem.
    const path = tmpPath();
    seedPreRename(path);
    const adapter = new SQLiteAdapter(path);
    await adapter.connect();
    const checkpoint = await adapter.lastCheckpoint("sess", "sb-1");
    await adapter.close();
    expect(checkpoint).not.toBeNull();
    expect((checkpoint!.payload as { snapshotId: string }).snapshotId).toBe("s1");
  });

  it("is a no-op on the second connect — which is what lets it run every time", async () => {
    const path = tmpPath();
    seedPreRename(path);

    for (let i = 0; i < 2; i++) {
      const adapter = new SQLiteAdapter(path);
      await adapter.connect();
      await adapter.close();
    }
    expect(eventsOf(path)).toEqual([
      "sandbox.created",
      "exec.started",
      "exec.output",
      "exec.completed",
      "sandbox.checkpoint_created",
      "sandbox.closed",
    ]);
  });

  it("preserves id, so nothing that orders on it is renumbered", async () => {
    const path = tmpPath();
    seedPreRename(path);
    const db = new Database(path);
    const before = db
      .query<{ id: number; ts: number }, []>("SELECT id, ts FROM alineo_events ORDER BY id")
      .all();
    db.close();

    const adapter = new SQLiteAdapter(path);
    await adapter.connect();
    await adapter.close();

    const after = new Database(path);
    expect(
      after
        .query<{ id: number; ts: number }, []>("SELECT id, ts FROM alineo_events ORDER BY id")
        .all(),
    ).toEqual(before);
    after.close();
  });

  it("leaves a name it has no mapping for alone rather than nulling it", async () => {
    const path = tmpPath();
    seedPreRename(path);
    const db = new Database(path);
    db.run(
      `INSERT INTO alineo_events (sandbox_id, name, step_idx, event, ts)
       VALUES ('sb-1', 'sess', 0, 'something_nobody_defined', 1006)`,
    );
    db.close();

    const adapter = new SQLiteAdapter(path);
    await adapter.connect();
    await adapter.close();

    expect(eventsOf(path)).toContain("something_nobody_defined");
  });

  it("builds a statement the sqlite driver actually accepts", () => {
    // A guard on the SQL shape itself: the CASE is generated, so a malformed one would only
    // surface at boot, on a user's database.
    const db = new Database(":memory:");
    db.run(MIGRATION_SQL);
    const { sql, params } = renameEventsStatement();
    expect(() => db.run(sql, params)).not.toThrow();
    db.close();
  });
});

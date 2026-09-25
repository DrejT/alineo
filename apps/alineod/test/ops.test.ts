/** Operator tooling: backups (src/ops/backup.ts) and the sandbox leak check (src/ops/leaks.ts). */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, backupDirName, prune, verifyDb } from "../src/ops/backup";
import { classify, listLiveSandboxes } from "../src/ops/leaks";

describe("backup", () => {
  let dir: string;
  let live: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alineod-backup-"));
    // A running alineod: WAL, auto-checkpoint off, connection held open — every row below lives
    // only in `alineod.db-wal`, exactly the state that made `cp` backups look empty on the VPS.
    live = new Database(join(dir, "alineod.db"), { create: true });
    live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    live.exec("CREATE TABLE ledger (seq INTEGER PRIMARY KEY, event TEXT)");
    for (let i = 0; i < 50; i++) live.query("INSERT INTO ledger (event) VALUES (?)").run(`e${i}`);
    mkdirSync(join(dir, "work", "results"), { recursive: true });
    writeFileSync(join(dir, "work", "results", "a1.md"), "the result");
  });

  afterEach(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("captures commits that are still only in the WAL — which a plain copy loses", () => {
    copyFileSync(join(dir, "alineod.db"), join(dir, "copied.db"));
    const copied = new Database(join(dir, "copied.db"));
    const tables = copied.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    copied.close();
    expect(tables).toEqual([]); // the pitfall: opens fine, has nothing

    const result = backup(
      {
        dbPath: join(dir, "alineod.db"),
        sdkLedgerPath: join(dir, "absent.db"),
        workDir: join(dir, "work"),
      },
      join(dir, "backups"),
    );

    expect(result.databases).toHaveLength(1); // the absent SDK ledger is skipped, not an error
    expect(result.databases[0]).toMatchObject({ integrity: "ok", tables: { ledger: 50 } });
    expect(verifyDb(join(result.dir, "alineod.db")).tables).toEqual({ ledger: 50 });
    expect(readdirSync(join(result.dir, "work", "results"))).toEqual(["a1.md"]);
  });

  test("prune keeps the newest N backup directories", () => {
    const root = join(dir, "backups");
    const names = [0, 1, 2].map((d) => backupDirName(new Date(Date.UTC(2026, 8, 20 + d))));
    for (const name of names) mkdirSync(join(root, name), { recursive: true });
    mkdirSync(join(root, "unrelated"));

    expect(prune(root, 2)).toEqual([names[0]]);
    expect(readdirSync(root).sort()).toEqual([names[1], names[2], "unrelated"].sort());
  });
});

describe("classify", () => {
  let db: Database;

  function agent(id: string, sandbox: string, state: string, outcome: string | null): void {
    db.query(
      "INSERT INTO agents (agent_id, run_id, state, outcome, sandbox_id) VALUES (?, 'r1', ?, ?, ?)",
    ).run(id, state, outcome, sandbox);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agents (agent_id TEXT, run_id TEXT, state TEXT, outcome TEXT, sandbox_id TEXT);
      CREATE TABLE ledger (seq INTEGER PRIMARY KEY, agent_id TEXT, event TEXT);
    `);
  });

  afterEach(() => db.close());

  test("sorts every live sandbox by what the ledger says alineod still needs", () => {
    agent("running", "sb-running", "running", null);
    agent("finished", "sb-finished", "done", "success"); // kept open on purpose: still promptable
    agent("released", "sb-released", "done", "success");
    db.exec("INSERT INTO ledger (agent_id, event) VALUES ('released', 'agent.released')");
    agent("aborted", "sb-aborted", "aborted", "aborted");
    agent("lost", "sb-lost", "lost", "lost");

    const live = ["sb-running", "sb-finished", "sb-released", "sb-aborted", "sb-lost", "sb-other"];
    const report = classify(
      db,
      live.map((id) => ({ id, state: "Running" })),
    );

    const verdicts = Object.fromEntries(report.sandboxes.map((s) => [s.sandboxId, s.verdict]));
    expect(verdicts).toEqual({
      "sb-running": "in-use",
      "sb-finished": "in-use",
      "sb-released": "leaked",
      "sb-aborted": "leaked",
      "sb-lost": "leaked",
      "sb-other": "foreign",
    });
    expect(report.missing).toEqual([]);
  });

  test("reports an agent whose sandbox is gone while alineod still needs it", () => {
    agent("paused", "sb-gone", "paused", null);
    agent("aborted", "sb-also-gone", "aborted", "aborted"); // gone and not needed: fine

    const report = classify(db, []);

    expect(report.missing).toEqual([
      { sandboxId: "sb-gone", agentId: "paused", runId: "r1", agentState: "paused" },
    ]);
  });
});

test("listLiveSandboxes follows OpenSandbox's pages instead of stopping at the first 20", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${url.searchParams.get("page")}/${req.headers.get("OPEN-SANDBOX-API-KEY")}`);
      const page = Number(url.searchParams.get("page"));
      return Response.json({
        items: [{ id: `sb-${page}`, status: { state: "Running" } }],
        pagination: { hasNextPage: page < 3 },
      });
    },
  });
  try {
    const live = await listLiveSandboxes(`http://127.0.0.1:${server.port}`, "k");
    expect(live.map((s) => s.id)).toEqual(["sb-1", "sb-2", "sb-3"]);
    expect(seen).toEqual(["1/k", "2/k", "3/k"]);
  } finally {
    void server.stop(true);
  }
});

/**
 * Off-box storage for alineod (durability-roadmap M4): the bucket layout, full backups in a bucket,
 * Litestream's config, and restoring a machine from either source. Everything runs against an
 * in-memory store and temp directories. Nothing here needs a bucket or the `litestream` binary.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBlobStore } from "alineo";
import { backup } from "../src/ops/backup";
import { litestreamConfig, litestreamRestoreArgs, replicaPath } from "../src/ops/litestream";
import {
  createOffboxStore,
  offboxEnabled,
  offboxFolder,
  type OffboxConfig,
} from "../src/ops/offbox";
import { downloadBackup, listBackups, pruneOffsite, uploadResult } from "../src/ops/offsite";
import { restoreState } from "../src/ops/restore";

const CFG: OffboxConfig = {
  bucket: "bkt",
  prefix: "alineod",
  instanceId: "main",
  endpoint: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "offbox-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(path: string, rows: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (n INTEGER);");
  for (let i = 0; i < rows; i++) db.query("INSERT INTO t VALUES (?)").run(i);
  db.close();
}

describe("bucket layout", () => {
  test("one folder per instance and kind", () => {
    expect(offboxFolder(CFG, "checkpoints")).toBe("alineod/main/checkpoints");
    expect(offboxFolder(CFG, "backups")).toBe("alineod/main/backups");
    expect(offboxFolder(CFG, "db")).toBe("alineod/main/db");
  });

  test("tolerates stray slashes and an empty prefix", () => {
    expect(offboxFolder({ prefix: "/a/", instanceId: "i" }, "db")).toBe("a/i/db");
    expect(offboxFolder({ prefix: "", instanceId: "i" }, "db")).toBe("i/db");
  });

  test("two instances never share a folder", () => {
    expect(offboxFolder({ ...CFG, instanceId: "a" }, "checkpoints")).not.toBe(
      offboxFolder({ ...CFG, instanceId: "b" }, "checkpoints"),
    );
  });

  test("no bucket means off-box is off and no store is built", () => {
    expect(offboxEnabled({ bucket: "" })).toBe(false);
    expect(createOffboxStore({ ...CFG, bucket: "" }, "checkpoints")).toBeUndefined();
  });

  test("a bucket builds a store whose references name the right folder", () => {
    const store = createOffboxStore(CFG, "checkpoints");
    expect(store?.refOf("sb-1/1-9.tar.gz")).toBe(
      "s3://bkt/alineod/main/checkpoints/sb-1/1-9.tar.gz",
    );
  });
});

describe("full backups in a bucket", () => {
  function localBackup(rows: number, at = new Date("2026-10-18T10:00:00Z")) {
    const src = join(dir, "src");
    makeDb(join(src, "alineod.db"), rows);
    makeDb(join(src, "sdk.db"), rows);
    mkdirSync(join(src, "work"), { recursive: true });
    writeFileSync(join(src, "work", "result.txt"), "answer");
    return backup(
      {
        dbPath: join(src, "alineod.db"),
        sdkLedgerPath: join(src, "sdk.db"),
        workDir: join(src, "work"),
      },
      join(dir, "backups"),
      at,
    );
  }

  test("upload writes every file and the manifest last", async () => {
    const store = new MemoryBlobStore();
    const order: string[] = [];
    const put = store.put.bind(store);
    store.put = async (k, b) => {
      order.push(k);
      await put(k, b);
    };

    const uploaded = await uploadResult(store, localBackup(3));

    expect(uploaded.files).toEqual(["alineod.db", "sdk.db", "work/result.txt"]);
    expect(order.at(-1)).toMatch(/\/COMPLETE$/);
    expect(order).toHaveLength(4);
  });

  test("a backup with no manifest is not offered", async () => {
    const store = new MemoryBlobStore();
    await store.put("alineod-2026-10-18T10-00-00Z/alineod.db", new Uint8Array(1));

    expect(await listBackups(store)).toEqual([]);
  });

  test("lists complete backups newest first", async () => {
    const store = new MemoryBlobStore();
    await uploadResult(store, localBackup(1, new Date("2026-10-16T00:00:00Z")));
    await uploadResult(store, localBackup(1, new Date("2026-10-18T00:00:00Z")));

    expect(await listBackups(store)).toEqual([
      "alineod-2026-10-18T00-00-00Z",
      "alineod-2026-10-16T00-00-00Z",
    ]);
  });

  test("download writes the same files back", async () => {
    const store = new MemoryBlobStore();
    const result = localBackup(5);
    const name = result.dir.split("/").pop()!;
    await uploadResult(store, result);
    const out = join(dir, "out");

    const written = await downloadBackup(store, name, out, (path, bytes) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, bytes);
    });

    expect(written.map((p) => p.replace(out, ""))).toEqual([
      "/alineod.db",
      "/sdk.db",
      "/work/result.txt",
    ]);
    expect(readFileSync(join(out, "work", "result.txt"), "utf-8")).toBe("answer");
  });

  test("prune keeps the newest N and removes abandoned uploads, leaving fresh ones", async () => {
    let now = 10 * 3_600_000;
    const store = new MemoryBlobStore(() => now);
    for (const n of ["b1", "b2", "b3"]) {
      await store.put(`${n}/f`, new Uint8Array(1));
      await store.put(`${n}/COMPLETE`, new TextEncoder().encode('{"files":["f"],"uploadedAt":0}'));
    }
    await store.put("half-old/f", new Uint8Array(1)); // never completed
    now += 2 * 3_600_000;
    await store.put("half-new/f", new Uint8Array(1)); // still uploading

    const removed = await pruneOffsite(store, 2, now);

    expect(removed).toEqual(["b1", "half-old"]);
    expect(store.keys()).toEqual(["b2/COMPLETE", "b2/f", "b3/COMPLETE", "b3/f", "half-new/f"]);
  });
});

describe("litestream config", () => {
  test("replicates each database to its own path under the db folder", () => {
    const yml = litestreamConfig(["/data/alineod.db", "/data/sdk.db"], CFG);

    expect(yml).toContain('- path: "/data/alineod.db"');
    expect(yml).toContain('path: "alineod/main/db/alineod.db"');
    expect(yml).toContain('path: "alineod/main/db/sdk.db"');
    expect(yml).toContain('bucket: "bkt"');
    expect(yml).toContain("sync-interval: 1s");
  });

  test("writes no credentials into the file", () => {
    const yml = litestreamConfig(["/data/a.db"], {
      ...CFG,
      accessKeyId: "AKIA-SECRET-ID",
      secretAccessKey: "super-secret",
    });

    expect(yml).not.toContain("AKIA-SECRET-ID");
    expect(yml).not.toContain("super-secret");
  });

  test("adds the endpoint and path-style addressing for a compatible service", () => {
    const yml = litestreamConfig(["/data/a.db"], {
      ...CFG,
      endpoint: "http://127.0.0.1:9000",
      region: "auto",
    });

    expect(yml).toContain('endpoint: "http://127.0.0.1:9000"');
    expect(yml).toContain("force-path-style: true");
    expect(yml).toContain('region: "auto"');
  });

  test("leaves out the endpoint for AWS", () => {
    expect(litestreamConfig(["/data/a.db"], CFG)).not.toContain("endpoint");
  });

  test("refuses two databases with one file name", () => {
    expect(() => litestreamConfig(["/a/x.db", "/b/X.db"], CFG)).toThrow(/share the file name/);
  });

  test("quotes a path that needs it", () => {
    expect(litestreamConfig(['/data/we "ird".db'], CFG)).toContain('"/data/we \\"ird\\".db"');
  });

  test("the replica path is the db folder plus the file name", () => {
    expect(replicaPath(CFG, "/anywhere/alineod-memory.db")).toBe(
      "alineod/main/db/alineod-memory.db",
    );
  });

  test("restore skips what is already there and what was never replicated", () => {
    expect(litestreamRestoreArgs("/tmp/l.yml", "/data/a.db")).toEqual([
      "restore",
      "-config",
      "/tmp/l.yml",
      "-if-db-not-exists",
      "-if-replica-exists",
      "-o",
      "/data/a.db",
      "/data/a.db",
    ]);
  });
});

describe("restoreState", () => {
  async function bucketWithBackup(rows: number) {
    const src = join(dir, "src");
    makeDb(join(src, "alineod.db"), rows);
    makeDb(join(src, "sdk.db"), rows);
    mkdirSync(join(src, "work"), { recursive: true });
    writeFileSync(join(src, "work", "result.txt"), "answer");
    const result = backup(
      {
        dbPath: join(src, "alineod.db"),
        sdkLedgerPath: join(src, "sdk.db"),
        workDir: join(src, "work"),
      },
      join(dir, "backups"),
      new Date("2026-10-18T10:00:00Z"),
    );
    const store = new MemoryBlobStore();
    await uploadResult(store, result);
    return store;
  }

  const targets = () => ({
    dbPaths: [join(dir, "new", "alineod.db"), join(dir, "new", "sdk.db")],
    workDir: join(dir, "new", "work"),
  });

  const rowCount = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()!.n;
    } finally {
      db.close();
    }
  };

  test("from a full backup: databases and work dir come back, verified", async () => {
    const backups = await bucketWithBackup(7);
    const t = targets();

    const result = await restoreState({ backups, targets: t, from: "backup" });

    expect(result.backup).toBe("alineod-2026-10-18T10-00-00Z");
    expect(result.workDirRestored).toBe(true);
    expect(result.databases.map((d) => d.integrity)).toEqual(["ok", "ok"]);
    expect(rowCount(t.dbPaths[0]!)).toBe(7);
    expect(readFileSync(join(t.workDir, "result.txt"), "utf-8")).toBe("answer");
  });

  test("refuses a machine that already has state, and --force replaces it", async () => {
    const backups = await bucketWithBackup(2);
    const t = targets();
    makeDb(t.dbPaths[0]!, 99);

    await expect(restoreState({ backups, targets: t, from: "backup" })).rejects.toThrow(
      /already has state/,
    );
    expect(rowCount(t.dbPaths[0]!)).toBe(99);

    await restoreState({ backups, targets: t, from: "backup", force: true });
    expect(rowCount(t.dbPaths[0]!)).toBe(2);
  });

  test("removes a leftover WAL so it cannot be replayed over the restored file", async () => {
    const backups = await bucketWithBackup(2);
    const t = targets();
    mkdirSync(join(t.dbPaths[0]!, ".."), { recursive: true });
    writeFileSync(`${t.dbPaths[0]!}-wal`, "stale");

    await restoreState({ backups, targets: t, from: "backup", force: true });

    expect(existsSync(`${t.dbPaths[0]!}-wal`)).toBe(false);
  });

  test("fails clearly when the bucket has no complete backup", async () => {
    await expect(
      restoreState({ backups: new MemoryBlobStore(), targets: targets(), from: "backup" }),
    ).rejects.toThrow(/no complete backup in the bucket/);
  });

  test("fails clearly when the named backup does not exist", async () => {
    const backups = await bucketWithBackup(1);
    await expect(
      restoreState({ backups, targets: targets(), from: "backup", backupName: "nope" }),
    ).rejects.toThrow();
  });

  test("from litestream: runs the restore for each database, then takes the work dir from the newest backup", async () => {
    const backups = await bucketWithBackup(4);
    const t = targets();
    const calls: string[][] = [];

    const result = await restoreState({
      backups,
      targets: t,
      from: "litestream",
      litestreamConfigPath: "/tmp/l.yml",
      runLitestream: (args) => {
        calls.push(args);
        // Stand in for the binary: it writes the restored file at the `-o` path.
        makeDb(args[args.indexOf("-o") + 1]!, 11);
        return { exitCode: 0, output: "" };
      },
    });

    expect(calls.map((c) => c.at(-1))).toEqual(t.dbPaths);
    expect(rowCount(t.dbPaths[1]!)).toBe(11);
    expect(result.workDirRestored).toBe(true);
  });

  test("from litestream with no full backup: databases restore and the work dir is reported missing", async () => {
    const t = targets();

    const result = await restoreState({
      backups: new MemoryBlobStore(),
      targets: t,
      from: "litestream",
      litestreamConfigPath: "/tmp/l.yml",
      runLitestream: (args) => {
        makeDb(args[args.indexOf("-o") + 1]!, 1);
        return { exitCode: 0, output: "" };
      },
    });

    expect(result.workDirRestored).toBe(false);
    expect(result.backup).toBeNull();
  });

  test("a failing litestream is an error that names the database and the output", async () => {
    await expect(
      restoreState({
        targets: targets(),
        from: "litestream",
        litestreamConfigPath: "/tmp/l.yml",
        runLitestream: () => ({ exitCode: 1, output: "no such bucket" }),
      }),
    ).rejects.toThrow(/litestream restore of .*alineod\.db failed \(exit 1\): no such bucket/);
  });

  test("a restored file that fails its integrity check is an error", async () => {
    const backups = await bucketWithBackup(1);
    await expect(
      restoreState({
        backups,
        targets: targets(),
        from: "backup",
        verify: (file) => ({ file, integrity: "page 3 is never used", tables: {} }),
      }),
    ).rejects.toThrow(/failed its integrity check/);
  });
});

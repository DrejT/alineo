/**
 * Bring alineod's state back onto an empty machine (durability-roadmap M4, 4.3).
 *
 * Two sources, and either is enough on its own:
 *
 *  - `litestream`: the three SQLite files from their continuous replica (seconds behind), plus the
 *    work dir from the newest full backup, because Litestream does not carry it.
 *  - `backup`: everything from one full backup in the bucket (as old as that backup).
 *
 * Checkpoints are not restored here. They stay in the bucket, and a restored agent downloads its
 * own when alineod restores its container (`restoreFromCheckpoint`). That is why this step is
 * short: it moves the ledgers and the work dir, and the agents recover themselves on boot.
 *
 * Refuses to touch a machine that already has state, unless `force` is set. Stop alineod first.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BlobStore } from "alineo";
import { verifyDb, type BackedUpDb } from "./backup";
import { litestreamRestoreArgs } from "./litestream";
import { downloadBackup, listBackups } from "./offsite";

export interface RestoreTargets {
  /** The SQLite files to restore, in order. */
  dbPaths: readonly string[];
  /** The one of them that holds a `sqlite-vec` index and needs the extension to be verified. */
  memoryDbPath?: string;
  workDir: string;
}

export interface RestoreOptions {
  /** The `backups/` store. Needed for `backup`, and for the work dir in `litestream` mode. */
  backups?: BlobStore;
  targets: RestoreTargets;
  from: "litestream" | "backup";
  /** A backup name, or the newest when left out. */
  backupName?: string;
  /** Replace state that is already there. */
  force?: boolean;
  /** Path of a generated `litestream.yml`. Required for `litestream`. */
  litestreamConfigPath?: string;
  /** Runs `litestream <args>`. A test passes a fake. */
  runLitestream?: (args: string[]) => { exitCode: number; output: string };
  /** Seam for tests: how `.db` files are checked. */
  verify?: (file: string, vec: boolean) => BackedUpDb;
}

export interface RestoreResult {
  databases: BackedUpDb[];
  /** The backup the work dir (and, for `backup`, the databases) came from, if any. */
  backup: string | null;
  workDirRestored: boolean;
}

const sidecars = (db: string): string[] => [db, `${db}-wal`, `${db}-shm`];

export async function restoreState(opts: RestoreOptions): Promise<RestoreResult> {
  const { targets } = opts;
  const present = [...targets.dbPaths.flatMap(sidecars), targets.workDir].filter(existsSync);
  if (present.length > 0 && !opts.force) {
    throw new Error(
      `cannot restore: this machine already has state (${present.join(", ")}). ` +
        `Stop alineod and use --force to replace it.`,
    );
  }
  for (const f of targets.dbPaths.flatMap(sidecars)) rmSync(f, { force: true });
  if (existsSync(targets.workDir)) rmSync(targets.workDir, { recursive: true, force: true });
  for (const db of targets.dbPaths) mkdirSync(dirname(db), { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), "alineod-restore-"));
  try {
    let backupName: string | null = null;
    let staged = false;
    const stage = async (): Promise<string | null> => {
      if (!opts.backups) return null;
      const name = opts.backupName ?? (await listBackups(opts.backups))[0];
      if (!name) return null;
      await downloadBackup(opts.backups, name, join(staging, name), (path, bytes) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      });
      staged = true;
      return name;
    };

    if (opts.from === "litestream") {
      if (!opts.litestreamConfigPath || !opts.runLitestream) {
        throw new Error("restore from litestream needs a config path and a way to run litestream");
      }
      for (const db of targets.dbPaths) {
        const run = opts.runLitestream(litestreamRestoreArgs(opts.litestreamConfigPath, db));
        if (run.exitCode !== 0) {
          throw new Error(
            `litestream restore of ${db} failed (exit ${run.exitCode}): ${run.output}`,
          );
        }
      }
      // The work dir only comes from a full backup. No backup means no results restored: say so.
      backupName = await stage();
    } else {
      backupName = await stage();
      if (!backupName) {
        throw new Error(
          opts.backupName
            ? `no complete backup named ${opts.backupName} in the bucket`
            : "no complete backup in the bucket",
        );
      }
      const dir = join(staging, backupName);
      for (const db of targets.dbPaths) {
        const src = join(dir, basename(db));
        if (existsSync(src)) cpSync(src, db);
      }
    }

    let workDirRestored = false;
    if (staged && backupName) {
      const work = join(staging, backupName, "work");
      if (existsSync(work)) {
        cpSync(work, targets.workDir, { recursive: true });
        workDirRestored = true;
      }
    }

    const verify = opts.verify ?? ((file, vec) => verifyDb(file, { vec }));
    const databases = targets.dbPaths
      .filter(existsSync)
      .map((db) => verify(db, db === targets.memoryDbPath));
    for (const d of databases) {
      if (d.integrity !== "ok") {
        throw new Error(`restored ${d.file} failed its integrity check: ${d.integrity}`);
      }
    }
    return { databases, backup: backupName, workDirRestored };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

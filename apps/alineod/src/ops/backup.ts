/**
 * Consistent backups of alineod's state, safe to take while alineod is running.
 *
 * Both databases run in WAL mode, so recent commits live in `<db>-wal`, not in the `.db` file.
 * Copying the `.db` alone gives a file that opens fine and is missing everything since the last
 * checkpoint — on the VPS that was a ~4 KB main file next to a multi-MB WAL, i.e. an empty-looking
 * database. `VACUUM INTO` reads through SQLite, WAL included, and writes one self-contained file.
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export interface BackupSources {
  /** alineod's own ledger (ALINEOD_DB_PATH). */
  dbPath: string;
  /** The SDK ledger (ALINEOD_SDK_LEDGER_PATH). Skipped if it doesn't exist yet. */
  sdkLedgerPath: string;
  /** Results and spec files (ALINEOD_WORK_DIR). Skipped if it doesn't exist yet. */
  workDir: string;
}

export interface BackedUpDb {
  file: string;
  integrity: string;
  tables: Record<string, number>;
}

export interface BackupResult {
  dir: string;
  databases: BackedUpDb[];
  workDir: string | null;
}

/** `alineod-2026-09-25T11-00-06Z` — sortable, and a valid directory name everywhere. */
export function backupDirName(at: Date = new Date()): string {
  return `alineod-${at
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-")}`;
}

function snapshotDb(source: string, target: string): BackedUpDb {
  const src = new Database(source, { readonly: true });
  try {
    src.exec("PRAGMA busy_timeout = 5000;");
    src.query("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  return verifyDb(target);
}

/** Open a backup read-only and check it: `integrity_check`, plus a row count per table. */
export function verifyDb(file: string): BackedUpDb {
  const db = new Database(file, { readonly: true });
  try {
    const integrity =
      db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ??
      "no result";
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    const tables: Record<string, number> = {};
    for (const name of names) {
      tables[name] =
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? 0;
    }
    return { file, integrity, tables };
  } finally {
    db.close();
  }
}

/** Write one backup directory under `destRoot`. Throws if a copy fails its integrity check. */
export function backup(sources: BackupSources, destRoot: string, at = new Date()): BackupResult {
  const dir = join(destRoot, backupDirName(at));
  mkdirSync(dir, { recursive: true });

  const databases: BackedUpDb[] = [];
  for (const path of [sources.dbPath, sources.sdkLedgerPath]) {
    if (!existsSync(path)) continue;
    const copy = snapshotDb(path, join(dir, basename(path)));
    if (copy.integrity !== "ok") {
      throw new Error(`backup of ${path} failed its integrity check: ${copy.integrity}`);
    }
    databases.push(copy);
  }

  let workDir: string | null = null;
  if (existsSync(sources.workDir)) {
    workDir = join(dir, "work");
    cpSync(sources.workDir, workDir, { recursive: true });
  }
  return { dir, databases, workDir };
}

/** Delete all but the newest `keep` backup directories under `destRoot`. Returns what it removed. */
export function prune(destRoot: string, keep: number): string[] {
  if (!existsSync(destRoot)) return [];
  const dirs = readdirSync(destRoot)
    .filter((name) => name.startsWith("alineod-"))
    .sort();
  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of doomed) rmSync(join(destRoot, name), { recursive: true, force: true });
  return doomed;
}

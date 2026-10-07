/**
 * Consistent backups of alineod's state, safe to take while alineod is running.
 *
 * Both databases run in WAL mode, so recent commits live in `<db>-wal`, not in the `.db` file.
 * Copying the `.db` alone gives a file that opens fine and is missing everything since the last
 * checkpoint — on the VPS that was a ~4 KB main file next to a multi-MB WAL, i.e. an empty-looking
 * database. `VACUUM INTO` reads through SQLite, WAL included, and writes one self-contained file.
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadSqliteVec } from "@alineo-labs/sqlite-memory";

export interface BackupSources {
  /** alineod's own ledger (ALINEOD_DB_PATH). */
  dbPath: string;
  /** The SDK ledger (ALINEOD_SDK_LEDGER_PATH). Skipped if it doesn't exist yet. */
  sdkLedgerPath: string;
  /**
   * Agent memory (ALINEOD_MEMORY_DB_PATH). Skipped if it doesn't exist yet. Unlike both ledgers
   * this one is NOT rebuildable from anything else — it is the only copy of what agents learned.
   */
  memoryDbPath?: string;
  /** Results and spec files (ALINEOD_WORK_DIR). Skipped if it doesn't exist yet. */
  workDir: string;
}

export interface BackedUpDb {
  file: string;
  integrity: string;
  tables: Record<string, number>;
}

/** Seams for tests; production passes none. */
export interface BackupDeps {
  /** How the `sqlite-vec` extension is loaded into a connection. Defaults to the provider's own. */
  loadVec?: (db: Database) => boolean;
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

/**
 * Open a database for backup or verification.
 *
 * `vec` is for the memory database only: semantic memory keeps its vectors in a `vec0` virtual
 * table, and SQLite refuses to read — or `VACUUM INTO` — a file whose virtual-table module isn't
 * loaded ("no such module: vec0"). It is loaded through `@alineo-labs/sqlite-memory`'s own
 * `loadSqliteVec`, the exact path the provider takes, and never for the two ledgers, which have
 * no such table. If the extension can't load here, SQLite reports it on the first statement that
 * needs it, which is the right place for that error.
 */
function openDb(
  path: string,
  vec: boolean,
  loadVec: BackupDeps["loadVec"] = loadSqliteVec,
): Database {
  const db = new Database(path, { readonly: true });
  if (vec) loadVec(db);
  return db;
}

/**
 * Fail before anything is written when the memory database can't be backed up on this host.
 *
 * A database with a `vec0` index can't be read, copied, or verified without the `sqlite-vec`
 * extension. `loadSqliteVec` reports "couldn't load" by returning `false`, quietly — and left to
 * the usual path, that surfaces late: the ledgers are already copied and the memory database,
 * the one copy of what agents learned, throws on its row count at the very end. Say so first.
 */
function assertMemoryReadable(label: string, path: string, loadVec: BackupDeps["loadVec"]): void {
  const db = new Database(path, { readonly: true });
  try {
    const loaded = (loadVec ?? loadSqliteVec)(db);
    const hasVecIndex = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%vec0%'")
      .get();
    if (!loaded && (hasVecIndex?.n ?? 0) > 0) {
      throw new Error(
        `cannot back up ${label} (${path}): it holds a sqlite-vec vector index, but the ` +
          `sqlite-vec extension could not be loaded on this host, so it can be neither read nor ` +
          `copied. Nothing was written.`,
      );
    }
  } finally {
    db.close();
  }
}

function snapshotDb(
  source: string,
  target: string,
  vec: boolean,
  loadVec: BackupDeps["loadVec"],
): BackedUpDb {
  const src = openDb(source, vec, loadVec);
  try {
    src.exec("PRAGMA busy_timeout = 5000;");
    src.query("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  return verifyDb(target, { vec, loadVec });
}

/** Open a backup read-only and check it: `integrity_check`, plus a row count per table. */
export function verifyDb(
  file: string,
  opts: { vec?: boolean; loadVec?: BackupDeps["loadVec"] } = {},
): BackedUpDb {
  const db = openDb(file, opts.vec ?? false, opts.loadVec);
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

/**
 * Write one backup directory under `destRoot`, all or nothing.
 *
 * The copies are assembled in a hidden `.alineod-<time>.partial` directory beside the real one and
 * moved into place with a single rename once every database has copied and verified. If anything
 * fails — a locked file, a failed integrity check, a full disk — the staging directory is removed
 * and the error thrown: a scheduled backup job sees a failure instead of a directory that looks
 * like a backup and is silently missing the database that mattered most.
 *
 * Throws if a copy fails its integrity check.
 */
export function backup(
  sources: BackupSources,
  destRoot: string,
  at = new Date(),
  deps: BackupDeps = {},
): BackupResult {
  // Each copy is written under its source's file name, so two sources sharing one would collide in
  // the backup directory — `VACUUM INTO` throws on the second, or (if the file isn't there yet)
  // one silently stands in for the other. Refuse up front, before anything is written, naming
  // both.
  const labelled = [
    ["ALINEOD_DB_PATH", sources.dbPath],
    ["ALINEOD_SDK_LEDGER_PATH", sources.sdkLedgerPath],
    ["ALINEOD_MEMORY_DB_PATH", sources.memoryDbPath],
  ] as const;
  const seen = new Map<string, string>();
  for (const [label, path] of labelled) {
    if (!path) continue;
    // Case-insensitive: Windows and macOS volumes treat `A.db` and `a.db` as one file.
    const key = basename(path).toLowerCase();
    const other = seen.get(key);
    if (other) {
      throw new Error(
        `cannot back up: ${other} and ${label} share the file name "${basename(path)}", ` +
          `so their copies would overwrite each other. Give them different file names.`,
      );
    }
    seen.set(key, label);
  }

  const name = backupDirName(at);
  const finalDir = join(destRoot, name);
  if (existsSync(finalDir)) throw new Error(`cannot back up: ${finalDir} already exists`);
  if (sources.memoryDbPath && existsSync(sources.memoryDbPath)) {
    assertMemoryReadable("ALINEOD_MEMORY_DB_PATH", sources.memoryDbPath, deps.loadVec);
  }

  const staging = join(destRoot, `.${name}.partial`);
  rmSync(staging, { recursive: true, force: true }); // left over from a crashed run
  mkdirSync(staging, { recursive: true });
  try {
    const databases: BackedUpDb[] = [];
    for (const [label, path] of labelled) {
      if (!path || !existsSync(path)) continue;
      const copy = snapshotDb(
        path,
        join(staging, basename(path)),
        label === "ALINEOD_MEMORY_DB_PATH",
        deps.loadVec,
      );
      if (copy.integrity !== "ok") {
        throw new Error(`backup of ${path} failed its integrity check: ${copy.integrity}`);
      }
      databases.push(copy);
    }

    let workDir: string | null = null;
    if (existsSync(sources.workDir)) {
      workDir = join(staging, "work");
      cpSync(sources.workDir, workDir, { recursive: true });
    }

    renameSync(staging, finalDir);
    return {
      dir: finalDir,
      databases: databases.map((d) => ({ ...d, file: join(finalDir, basename(d.file)) })),
      workDir: workDir ? join(finalDir, "work") : null,
    };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** A staging directory this old belongs to a run that died, not one still writing. */
const STALE_PARTIAL_MS = 60 * 60_000;

/**
 * Delete all but the newest `keep` backup directories under `destRoot`, and any staging
 * directory abandoned by a crashed run. Returns what it removed.
 */
export function prune(destRoot: string, keep: number): string[] {
  if (!existsSync(destRoot)) return [];
  const names = readdirSync(destRoot);
  const dirs = names.filter((name) => name.startsWith("alineod-")).sort();
  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep));
  const abandoned = names.filter(
    (name) =>
      name.startsWith(".alineod-") &&
      name.endsWith(".partial") &&
      Date.now() - statSync(join(destRoot, name)).mtimeMs > STALE_PARTIAL_MS,
  );
  for (const name of [...doomed, ...abandoned]) {
    rmSync(join(destRoot, name), { recursive: true, force: true });
  }
  return [...doomed, ...abandoned];
}

/**
 * `[destDir] [--keep N]`, in either order. Lives here, not inline in the script, so it can be
 * tested: the inline version located the destination by position and dropped it whenever `--keep`
 * was absent, so `backup.ts /mnt/offsite` quietly wrote to `./backups` instead.
 *
 * @throws on an unknown option, a second positional, or a `--keep` that isn't a positive integer.
 */
export function parseBackupArgs(argv: readonly string[]): { dest: string; keep?: number } {
  let dest: string | undefined;
  let keep: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--keep") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--keep takes a positive integer");
      keep = n;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else if (dest === undefined) {
      dest = arg;
    } else {
      throw new Error(`unexpected extra argument ${arg}`);
    }
  }
  return { dest: dest ?? "./backups", keep };
}

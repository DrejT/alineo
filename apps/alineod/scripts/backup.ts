/**
 * Back up alineod's state: both ledgers and the memory database (via VACUUM INTO) and the work dir. Safe while alineod is
 * running. Reads the same ALINEOD_* variables as the daemon, so run it with the daemon's env.
 *
 *   bun apps/alineod/scripts/backup.ts [destDir=./backups] [--keep N]
 *
 * Restore: stop alineod, copy the .db files over the originals (delete any leftover
 * `-wal`/`-shm` next to them first), copy `work/` back to ALINEOD_WORK_DIR, start alineod.
 * Its lease and crash recovery take it from there.
 *
 * Never back these databases up with `cp`: in WAL mode the recent commits live in `-wal`, and a
 * copied `.db` alone opens fine and is missing them. See src/ops/backup.ts.
 */
import { DB_PATH, MEMORY_DB_PATH, SDK_LEDGER_PATH, WORK_DIR } from "../config";
import { backup, parseBackupArgs, prune } from "../src/ops/backup";

let parsed: ReturnType<typeof parseBackupArgs>;
try {
  parsed = parseBackupArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
const { dest, keep } = parsed;

const result = backup(
  {
    dbPath: DB_PATH,
    sdkLedgerPath: SDK_LEDGER_PATH,
    memoryDbPath: MEMORY_DB_PATH,
    workDir: WORK_DIR,
  },
  dest,
);
console.log(`backup: ${result.dir}`);
for (const db of result.databases) {
  const counts = Object.entries(db.tables)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  console.log(`  ${db.file}  integrity=${db.integrity}  ${counts}`);
}
console.log(`  work dir: ${result.workDir ?? "(none yet)"}`);
if (keep !== undefined) {
  for (const name of prune(dest, keep)) console.log(`  pruned ${name}`);
}

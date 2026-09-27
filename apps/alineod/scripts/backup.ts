/**
 * Back up alineod's state: both ledgers (via VACUUM INTO) and the work dir. Safe while alineod is
 * running. Reads the same ALINEOD_* variables as the daemon, so run it with the daemon's env.
 *
 *   bun apps/alineod/scripts/backup.ts [destDir=./backups] [--keep N]
 *
 * Restore: stop alineod, copy the two .db files over the originals (delete any leftover
 * `-wal`/`-shm` next to them first), copy `work/` back to ALINEOD_WORK_DIR, start alineod.
 * Its lease and crash recovery take it from there.
 *
 * Never back these databases up with `cp`: in WAL mode the recent commits live in `-wal`, and a
 * copied `.db` alone opens fine and is missing them. See src/ops/backup.ts.
 */
import { DB_PATH, SDK_LEDGER_PATH, WORK_DIR } from "../config";
import { backup, prune } from "../src/ops/backup";

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keep = keepAt >= 0 ? Number(args[keepAt + 1]) : undefined;
if (keep !== undefined && !(Number.isInteger(keep) && keep > 0)) {
  console.error("--keep takes a positive integer");
  process.exit(2);
}
const dest = args.find((a, i) => !a.startsWith("--") && i !== keepAt + 1) ?? "./backups";

const result = backup({ dbPath: DB_PATH, sdkLedgerPath: SDK_LEDGER_PATH, workDir: WORK_DIR }, dest);
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

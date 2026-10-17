/**
 * Back up alineod's state: both ledgers and the memory database (via VACUUM INTO) and the work dir. Safe while alineod is
 * running. Reads the same ALINEOD_* variables as the daemon, so run it with the daemon's env.
 *
 *   bun apps/alineod/scripts/backup.ts [destDir=./backups] [--keep N] [--offsite]
 *
 * `--offsite` also uploads the finished backup to the bucket (ALINEOD_BACKUP_BUCKET), with
 * `--keep` applied there too. Litestream replicates the three databases continuously; this adds the
 * work dir and a second way back. Checkpoints are not in this backup: they are uploaded as they are
 * taken.
 *
 * Restore: stop alineod, copy the .db files over the originals (delete any leftover
 * `-wal`/`-shm` next to them first), copy `work/` back to ALINEOD_WORK_DIR, start alineod.
 * Its lease and crash recovery take it from there.
 *
 * Never back these databases up with `cp`: in WAL mode the recent commits live in `-wal`, and a
 * copied `.db` alone opens fine and is missing them. See src/ops/backup.ts.
 */
import { DB_PATH, MEMORY_DB_PATH, SDK_LEDGER_PATH, WORK_DIR } from "../config";
import { offboxConfig } from "../src/engine/offbox";
import { backup, parseBackupArgs, prune } from "../src/ops/backup";
import { pruneOffsite, uploadResult } from "../src/ops/offsite";
import { createOffboxStore } from "../src/ops/offbox";

let parsed: ReturnType<typeof parseBackupArgs>;
try {
  parsed = parseBackupArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
const { dest, keep, offsite } = parsed;

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

if (offsite) {
  const store = createOffboxStore(offboxConfig, "backups");
  if (!store) {
    console.error("--offsite needs ALINEOD_BACKUP_BUCKET");
    process.exit(2);
  }
  const uploaded = await uploadResult(store, result);
  console.log(`  uploaded ${uploaded.files.length} files as ${uploaded.name}`);
  if (keep !== undefined) {
    for (const name of await pruneOffsite(store, keep)) console.log(`  pruned offsite ${name}`);
  }
}

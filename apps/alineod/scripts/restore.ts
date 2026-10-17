/**
 * Restore alineod's state onto an empty machine from the backup bucket.
 *
 *   bun apps/alineod/scripts/restore.ts [--from litestream|backup] [--backup NAME] [--force]
 *
 *   --from litestream   (default) the three SQLite files from their Litestream replica, and the
 *                       work dir from the newest full backup. Needs the `litestream` binary.
 *   --from backup       everything from one full backup made with `backup.ts --offsite`.
 *   --backup NAME       use this backup instead of the newest.
 *   --force             replace state already on this machine. Stop alineod first.
 *
 * Reads the same ALINEOD_* variables as the daemon, so run it with the daemon's env. Start alineod
 * afterwards: its crash recovery restores each agent's container, and each agent fetches its own
 * checkpoint from the bucket. See the restore page in the alineod docs for the whole procedure.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_PATH, MEMORY_DB_PATH, MEMORY_ENABLED, SDK_LEDGER_PATH, WORK_DIR } from "../config";
import { offboxConfig } from "../src/engine/offbox";
import { litestreamConfig } from "../src/ops/litestream";
import { createOffboxStore, offboxEnabled } from "../src/ops/offbox";
import { restoreState } from "../src/ops/restore";

function parse(argv: readonly string[]) {
  let from: "litestream" | "backup" = "litestream";
  let backupName: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") force = true;
    else if (arg === "--from") {
      const v = argv[++i];
      if (v !== "litestream" && v !== "backup")
        throw new Error("--from takes litestream or backup");
      from = v;
    } else if (arg === "--backup") {
      backupName = argv[++i];
      if (!backupName) throw new Error("--backup takes a backup name");
    } else throw new Error(`unknown option ${arg}`);
  }
  return { from, backupName, force };
}

let args: ReturnType<typeof parse>;
try {
  args = parse(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

if (!offboxEnabled(offboxConfig)) {
  console.error("ALINEOD_BACKUP_BUCKET is not set: there is nothing to restore from.");
  process.exit(2);
}

const dbPaths = [DB_PATH, SDK_LEDGER_PATH, ...(MEMORY_ENABLED ? [MEMORY_DB_PATH] : [])];
const configPath = join(mkdtempSync(join(tmpdir(), "alineod-litestream-")), "litestream.yml");
writeFileSync(configPath, litestreamConfig(dbPaths, offboxConfig));

try {
  const result = await restoreState({
    backups: createOffboxStore(offboxConfig, "backups"),
    targets: {
      dbPaths,
      memoryDbPath: MEMORY_ENABLED ? MEMORY_DB_PATH : undefined,
      workDir: WORK_DIR,
    },
    from: args.from,
    backupName: args.backupName,
    force: args.force,
    litestreamConfigPath: configPath,
    runLitestream: (litestreamArgs) => {
      const run = Bun.spawnSync(["litestream", ...litestreamArgs]);
      return { exitCode: run.exitCode, output: `${run.stdout}${run.stderr}` };
    },
  });
  for (const db of result.databases) {
    const counts = Object.entries(db.tables)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    console.log(`restored ${db.file}  integrity=${db.integrity}  ${counts}`);
  }
  console.log(
    result.workDirRestored
      ? `work dir restored from backup ${result.backup}`
      : "work dir NOT restored: no full backup in the bucket. Results written before the loss are gone.",
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

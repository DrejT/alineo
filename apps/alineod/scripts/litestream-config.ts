/**
 * Print the Litestream config for alineod's three SQLite files.
 *
 *   bun apps/alineod/scripts/litestream-config.ts > /etc/litestream.yml
 *   LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=… litestream replicate
 *
 * Reads the same ALINEOD_* variables as the daemon, so run it with the daemon's env. Needs
 * ALINEOD_BACKUP_BUCKET. See the restore page in the alineod docs.
 */
import { DB_PATH, MEMORY_DB_PATH, MEMORY_ENABLED, SDK_LEDGER_PATH } from "../config";
import { offboxConfig } from "../src/engine/offbox";
import { litestreamConfig } from "../src/ops/litestream";
import { offboxEnabled } from "../src/ops/offbox";

if (!offboxEnabled(offboxConfig)) {
  console.error("ALINEOD_BACKUP_BUCKET is not set: there is nowhere to replicate to.");
  process.exit(2);
}

const dbs = [DB_PATH, SDK_LEDGER_PATH, ...(MEMORY_ENABLED ? [MEMORY_DB_PATH] : [])];
process.stdout.write(litestreamConfig(dbs, offboxConfig));

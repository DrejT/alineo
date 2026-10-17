/**
 * Where alineod keeps its off-box copies (durability-roadmap M4).
 *
 * One bucket, one folder per alineod instance, one sub-folder per kind of thing:
 *
 *   <prefix>/<instance id>/checkpoints/   turn checkpoints (4.1), written after every turn
 *   <prefix>/<instance id>/backups/       full backups from `scripts/backup.ts --offsite` (4.2)
 *   <prefix>/<instance id>/db/            Litestream replicas of the three SQLite files (4.2)
 *
 * The instance id is in every path so that a second alineod (a shard, a standby) can share the
 * bucket without a migration. Pure functions only: the config module that reads the environment
 * lives in `engine/offbox.ts`, so this file is easy to test.
 */
import { S3BlobStore, type BlobStore } from "alineo";

export interface OffboxConfig {
  /** Empty means off-box storage is not configured. */
  bucket: string;
  prefix: string;
  instanceId: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type OffboxKind = "checkpoints" | "backups" | "db";

/** The folder inside the bucket for one kind of data, without leading or trailing slash. */
export function offboxFolder(cfg: Pick<OffboxConfig, "prefix" | "instanceId">, kind: OffboxKind) {
  return [cfg.prefix, cfg.instanceId, kind]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
}

export function offboxEnabled(cfg: Pick<OffboxConfig, "bucket">): boolean {
  return cfg.bucket !== "";
}

/** A store for one kind of data, or `undefined` when no bucket is configured. */
export function createOffboxStore(cfg: OffboxConfig, kind: OffboxKind): BlobStore | undefined {
  if (!offboxEnabled(cfg)) return undefined;
  return new S3BlobStore({
    bucket: cfg.bucket,
    prefix: offboxFolder(cfg, kind),
    endpoint: cfg.endpoint || undefined,
    region: cfg.region || undefined,
    accessKeyId: cfg.accessKeyId || undefined,
    secretAccessKey: cfg.secretAccessKey || undefined,
  });
}

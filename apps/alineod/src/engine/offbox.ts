/**
 * The off-box checkpoint store, built once from the environment (durability-roadmap M4, 4.1).
 * `undefined` when `ALINEOD_BACKUP_BUCKET` is not set, which keeps every checkpoint on the host
 * disk exactly as before.
 */
import type { BlobStore } from "alineo";
import {
  BACKUP_ACCESS_KEY_ID,
  BACKUP_BUCKET,
  BACKUP_ENDPOINT,
  BACKUP_PREFIX,
  BACKUP_REGION,
  BACKUP_SECRET_ACCESS_KEY,
  INSTANCE_ID,
} from "../../config";
import { createOffboxStore, type OffboxConfig } from "../ops/offbox";

/** The bucket settings from the environment. */
export const offboxConfig: OffboxConfig = {
  bucket: BACKUP_BUCKET,
  prefix: BACKUP_PREFIX,
  instanceId: INSTANCE_ID,
  endpoint: BACKUP_ENDPOINT,
  region: BACKUP_REGION,
  accessKeyId: BACKUP_ACCESS_KEY_ID,
  secretAccessKey: BACKUP_SECRET_ACCESS_KEY,
};

export const checkpointBlobStore: BlobStore | undefined = createOffboxStore(
  offboxConfig,
  "checkpoints",
);

/** What `sdkResume` / `sdkReattach` add so a restore can fetch a checkpoint the host lost. */
export function offboxOptions(): { blobStore?: BlobStore } {
  return checkpointBlobStore ? { blobStore: checkpointBlobStore } : {};
}

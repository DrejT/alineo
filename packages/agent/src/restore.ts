import { readFile } from "node:fs/promises";
import { LedgerEvent, type IStorageAdapter, type SandboxHandle } from "@alineo-labs/core";
import type { BlobStore } from "./blob-store";

/**
 * durability-roadmap M3, 3.3 — the other half of `./checkpoint.ts`. Finds the latest
 * `AgentCheckpointed` record for a sandbox from its own ledger (the same `IStorageAdapter` the
 * sandbox already writes to via `sb.emit()` — this works whether that sandbox still exists or
 * not, since the ledger is exactly what's supposed to survive it) and extracts the tarball
 * into a *different*, already-running container — the one a fresh snapshot restore just
 * provisioned, per `resumeAgent()`'s fallback in `./agent/factory.ts`.
 *
 * M4, 4.1: a checkpoint may also carry a `remoteRef` into object storage. On the same host the
 * local file is read first. After a disk loss the local file is gone and the blob is fetched.
 */

export interface LatestCheckpoint {
  turn: number;
  /** A path on the host that took the checkpoint. */
  snapshotRef: string;
  /** The same tarball in object storage, when the upload worked (M4, 4.1). */
  remoteRef?: string;
}

/**
 * Every checkpoint recorded for this sandbox, newest first. Restore tries them in this order, so
 * one lost or unreadable tarball costs a turn of history and not the whole conversation.
 */
export async function findCheckpoints(
  adapter: IStorageAdapter,
  name: string,
  sandboxId: string,
): Promise<LatestCheckpoint[]> {
  const entries = await adapter.readAll(name, sandboxId);
  return entries
    .filter((e) => e.event === LedgerEvent.AgentCheckpointed)
    .map((e) => e.payload as LatestCheckpoint)
    .reverse();
}

/** `undefined` if this sandbox was never checkpointed — not an error; the caller falls back
 * to whatever state a bare snapshot restore already produced. */
export async function findLatestCheckpoint(
  adapter: IStorageAdapter,
  name: string,
  sandboxId: string,
): Promise<LatestCheckpoint | undefined> {
  return (await findCheckpoints(adapter, name, sandboxId))[0];
}

export interface RestoreOptions {
  /** Where a `remoteRef` is fetched from. Without it, only the local file can be used. */
  blobStore?: BlobStore;
}

/**
 * The bytes of one checkpoint. Local file first, because it needs no network. If that is gone (a
 * new host, a wiped disk) and the checkpoint has a `remoteRef` the store recognises, download it.
 *
 * @throws if neither source has it. The message names both attempts.
 */
export async function fetchCheckpoint(
  checkpoint: LatestCheckpoint,
  opts: RestoreOptions = {},
): Promise<Uint8Array> {
  let localError: unknown;
  try {
    return await readFile(checkpoint.snapshotRef);
  } catch (err) {
    localError = err;
  }
  const key =
    checkpoint.remoteRef && opts.blobStore ? opts.blobStore.keyOf(checkpoint.remoteRef) : undefined;
  if (key === undefined || !opts.blobStore) {
    throw new Error(
      `checkpoint for turn ${checkpoint.turn} is not on this host (${checkpoint.snapshotRef}: ` +
        `${localError instanceof Error ? localError.message : String(localError)})` +
        (checkpoint.remoteRef
          ? ` and ${checkpoint.remoteRef} cannot be fetched: no BlobStore that owns it was given`
          : " and it has no off-box copy"),
    );
  }
  try {
    return await opts.blobStore.get(key);
  } catch (err) {
    throw new Error(
      `checkpoint for turn ${checkpoint.turn} is not on this host and ${checkpoint.remoteRef} ` +
        `could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The newest checkpoint whose tarball can be read, with its bytes, or `undefined` when none can.
 * `skipped` lists what was passed over and why, for the caller to log.
 */
export async function pickRestorable(
  candidates: LatestCheckpoint[],
  opts: RestoreOptions = {},
): Promise<{
  checkpoint: LatestCheckpoint;
  bytes: Uint8Array;
  skipped: Array<{ turn: number; reason: string }>;
} | null> {
  const skipped: Array<{ turn: number; reason: string }> = [];
  for (const checkpoint of candidates) {
    try {
      return { checkpoint, bytes: await fetchCheckpoint(checkpoint, opts), skipped };
    } catch (err) {
      skipped.push({
        turn: checkpoint.turn,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

/**
 * Extract checkpoint bytes into `sb`, overwriting whatever a fresh container's own setup left in
 * place at the same paths. Byte-safe on both ends (`writeFileBytes`/raw `tar xzf`) — the same
 * corruption risk `takeCheckpoint()`'s doc comment already covers on the capture side applies
 * symmetrically here on restore.
 */
export async function extractCheckpoint(sb: SandboxHandle, bytes: Uint8Array): Promise<void> {
  const tmpTarPath = `/tmp/alineo-restore-${crypto.randomUUID()}.tar.gz`;
  try {
    await sb.writeFileBytes(tmpTarPath, bytes);
    await sb.exec(`tar xzf ${tmpTarPath} -C /`);
  } finally {
    try {
      await sb.exec(`rm -f ${tmpTarPath}`, { strict: false });
    } catch {
      /* best-effort cleanup only */
    }
  }
}

/**
 * Extract a checkpoint tarball into `sb`. `snapshotRef` is the host path `takeCheckpoint()` stored
 * it at. Pass `remoteRef` and `blobStore` to fall back to object storage when that file is gone.
 */
export async function restoreCheckpoint(
  sb: SandboxHandle,
  snapshotRef: string,
  opts: RestoreOptions & { remoteRef?: string } = {},
): Promise<void> {
  const bytes = await fetchCheckpoint(
    { turn: 0, snapshotRef, remoteRef: opts.remoteRef },
    { blobStore: opts.blobStore },
  );
  await extractCheckpoint(sb, bytes);
}

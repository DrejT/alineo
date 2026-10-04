import { readFile } from "node:fs/promises";
import { LedgerEvent, type IStorageAdapter, type SandboxHandle } from "@alineo-labs/core";

/**
 * durability-roadmap M3, 3.3 — the other half of `./checkpoint.ts`. Finds the latest
 * `AgentCheckpointed` record for a sandbox from its own ledger (the same `IStorageAdapter` the
 * sandbox already writes to via `sb.emit()` — this works whether that sandbox still exists or
 * not, since the ledger is exactly what's supposed to survive it) and extracts the tarball
 * into a *different*, already-running container — the one a fresh snapshot restore just
 * provisioned, per `resumeAgent()`'s fallback in `./agent/factory.ts`.
 */

export interface LatestCheckpoint {
  turn: number;
  snapshotRef: string;
}

/** `undefined` if this sandbox was never checkpointed — not an error; the caller falls back
 * to whatever state a bare snapshot restore already produced. */
export async function findLatestCheckpoint(
  adapter: IStorageAdapter,
  name: string,
  sandboxId: string,
): Promise<LatestCheckpoint | undefined> {
  const entries = await adapter.readAll(name, sandboxId);
  const latest = entries.findLast((e) => e.event === LedgerEvent.AgentCheckpointed);
  return latest?.payload as LatestCheckpoint | undefined;
}

/**
 * Extract a checkpoint tarball (from the host path `takeCheckpoint()` stored it at) into `sb`,
 * overwriting whatever a fresh container's own setup left in place at the same paths. Byte-safe
 * on both ends (`writeFileBytes`/raw `tar xzf`) — the same corruption risk `takeCheckpoint()`'s
 * doc comment already covers on the capture side applies symmetrically here on restore.
 */
export async function restoreCheckpoint(sb: SandboxHandle, snapshotRef: string): Promise<void> {
  const bytes = await readFile(snapshotRef);
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

import type { IStorageAdapter, LedgerEntry, SandboxDetails } from "@alineo-labs/core";
import type { ResourceRef } from "./types";

/** One sandbox session's identity, as needed to read its ledger entries back out. */
export interface SandboxSessionRef {
  name: string;
  sandboxId: string;
}

export interface EpisodicRecallOptions {
  /**
   * Resolve which sandbox sessions belong to a resource. Episodic memory needs no new
   * storage — it's a read-shaped view over what the ledger already owns — because
   * `SandboxDetails.resourceId` is threaded through the ledger's `sandbox_created` payload
   * the same way `runId` already was, not a new schema column. The default resolver matches
   * on that field; sessions written before it existed (or by a caller that never set
   * `SandboxOptions.resourceId`) fall back to matching the ledger's `name` against
   * `resourceId` — i.e. sandboxes named after the resource they belong to. Supply a custom
   * resolver if neither convention fits your app.
   */
  resolveSessions?: (adapter: IStorageAdapter, ref: ResourceRef) => Promise<SandboxSessionRef[]>;
  /** Return only the most recent N entries across all resolved sessions, oldest first. */
  limit?: number;
  /**
   * `"flat"` (default) returns only the entries of sessions directly resolved for this
   * resource. `"lineage"` also walks each resolved session's `parentSandboxId` chain
   * (written by `sb.fork()`) upward and includes every ancestor session's entries too — so
   * memory recalled for a forked sandbox includes what happened before the fork. Still one
   * merged, flat, time-ordered stream in the result — alineo's ledger has no branch/lane
   * concept the way e.g. Pi's own session storage does, so "lineage" is the closest
   * approximation to branch-awareness available without inventing one.
   */
  branch?: "flat" | "lineage";
}

/** The default session resolver — exported so `episodicTree()` (a separate module) can reuse
 *  it as its own default without duplicating the resourceId/name-fallback matching logic. */
export async function resolveSessionsByResourceId(
  adapter: IStorageAdapter,
  ref: ResourceRef,
): Promise<SandboxSessionRef[]> {
  const details = await adapter.listAllSandboxDetails();
  return details
    .filter(
      (d) => d.resourceId === ref.resourceId || (d.resourceId == null && d.name === ref.resourceId),
    )
    .map((d) => ({ name: d.name, sandboxId: d.sandboxId }));
}

/** Walk `parentSandboxId` upward from each of `sessions`, returning the transitive closure
 * (originals included, no duplicates). Stops at a sandboxId with no known details (deleted,
 * or from before this field existed) rather than throwing. Exported for `episodicTree()`. */
export async function withAncestors(
  adapter: IStorageAdapter,
  sessions: SandboxSessionRef[],
): Promise<SandboxSessionRef[]> {
  const allDetails = await adapter.listAllSandboxDetails();
  const bySandboxId = new Map<string, SandboxDetails>(allDetails.map((d) => [d.sandboxId, d]));

  const seen = new Map<string, SandboxSessionRef>();
  for (const session of sessions) {
    let current: SandboxSessionRef | undefined = session;
    while (current && !seen.has(current.sandboxId)) {
      seen.set(current.sandboxId, current);
      const parentId: string | undefined = bySandboxId.get(current.sandboxId)?.parentSandboxId;
      const parentDetails: SandboxDetails | undefined = parentId
        ? bySandboxId.get(parentId)
        : undefined;
      current = parentDetails
        ? { name: parentDetails.name, sandboxId: parentDetails.sandboxId }
        : undefined;
    }
  }
  return [...seen.values()];
}

/**
 * Episodic memory, deliberately not a provider at all: it's a read API over the ledger
 * alineo already has (`@alineo-labs/core`'s `IStorageAdapter`), reshaped by `resourceId`. No
 * new storage, no ledger schema change — `resourceId` rides along in the existing
 * `sandbox_created` payload the same way `runId` does.
 */
export async function episodicRecall(
  adapter: IStorageAdapter,
  ref: ResourceRef,
  opts: EpisodicRecallOptions = {},
): Promise<LedgerEntry[]> {
  const resolve = opts.resolveSessions ?? resolveSessionsByResourceId;
  let sessions = await resolve(adapter, ref);

  if (opts.branch === "lineage") {
    sessions = await withAncestors(adapter, sessions);
  }

  const perSession = await Promise.all(
    sessions.map((session) => adapter.readAll(session.name, session.sandboxId)),
  );
  const entries = perSession.flat().sort((a, b) => a.ts - b.ts);

  return opts.limit != null ? entries.slice(-opts.limit) : entries;
}

import type { IStorageAdapter, LedgerEntry } from "@alineo-labs/core";
import type { ResourceRef } from "./types";

/** One sandbox session's identity, as needed to read its ledger entries back out. */
export interface SandboxSessionRef {
  name: string;
  sandboxId: string;
}

export interface EpisodicRecallOptions {
  /**
   * Resolve which sandbox sessions belong to a resource. Episodic memory needs no new
   * storage or ledger schema change — it's a read-shaped view over what the ledger already
   * owns — but the ledger has no `resourceId` column (`IStorageAdapter.readAll` is keyed by
   * `name`/`sandboxId`, and nothing like `resourceId` exists anywhere in the ledger schema
   * today). Rather than force a schema migration to answer "which sessions belong to this
   * resource," the default resolver treats a session's `name` as the join key: name every
   * sandbox after the `resourceId` it belongs to, and `episodicRecall` finds it via
   * `listAllSandboxDetails`. Apps with a different naming convention can supply their own
   * resolver instead — see the resourceId↔sandboxId indexing question in the memory-layer
   * research notes for why this is left a caller-supplied seam rather than a fixed index.
   */
  resolveSessions?: (adapter: IStorageAdapter, ref: ResourceRef) => Promise<SandboxSessionRef[]>;
  /** Return only the most recent N entries across all resolved sessions, oldest first. */
  limit?: number;
}

async function resolveSessionsByName(
  adapter: IStorageAdapter,
  ref: ResourceRef,
): Promise<SandboxSessionRef[]> {
  const details = await adapter.listAllSandboxDetails();
  return details
    .filter((d) => d.name === ref.resourceId)
    .map((d) => ({ name: d.name, sandboxId: d.sandboxId }));
}

/**
 * Episodic memory, deliberately not a provider at all: the exploration research's own gap
 * analysis already concluded this is "a read API over the existing ledger, reshaped by
 * resourceId... without touching the execution ledger's schema." That means no new pluggable
 * interface is needed — it's a pure function over the `IStorageAdapter` alineo already has,
 * merging and time-ordering every resolved session's ledger entries.
 *
 * Flat, not branch-aware: alineo's ledger has no branch/lane concept the way Pi's own
 * session storage does, so this returns one merged chronological stream. Revisit if/when the
 * ledger grows branching.
 */
export async function episodicRecall(
  adapter: IStorageAdapter,
  ref: ResourceRef,
  opts: EpisodicRecallOptions = {},
): Promise<LedgerEntry[]> {
  const resolve = opts.resolveSessions ?? resolveSessionsByName;
  const sessions = await resolve(adapter, ref);

  const perSession = await Promise.all(
    sessions.map((session) => adapter.readAll(session.name, session.sandboxId)),
  );
  const entries = perSession.flat().sort((a, b) => a.ts - b.ts);

  return opts.limit != null ? entries.slice(-opts.limit) : entries;
}

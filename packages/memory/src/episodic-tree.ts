import type { IStorageAdapter, LedgerEntry } from "@alineo-labs/core";
import { resolveSessionsByResourceId, withAncestors } from "./episodic";
import type { SandboxSessionRef } from "./episodic";
import type { ResourceRef } from "./types";

/** One session's place in the fork tree — its own entries plus every session forked from it. */
export interface EpisodicBranch {
  sandboxId: string;
  name: string;
  /** Absent for a root branch (a session with no known parent, or whose parent wasn't
   *  resolved into this tree). */
  parentSandboxId?: string;
  /** This session's own ledger entries, time-ordered. Does not include descendants' entries —
   *  that's what `children` is for. */
  entries: LedgerEntry[];
  /** Sessions forked from this one, in the same shape, recursively. */
  children: EpisodicBranch[];
}

export interface EpisodicTreeOptions {
  /** Same resolver contract as `EpisodicRecallOptions.resolveSessions`. */
  resolveSessions?: (adapter: IStorageAdapter, ref: ResourceRef) => Promise<SandboxSessionRef[]>;
}

/**
 * The branch-aware counterpart to `episodicRecall()`: instead of flattening every resolved
 * session (plus ancestry) into one merged chronological stream, this returns the actual fork
 * tree — each session as its own node, `sb.fork()`-descended sessions nested under their
 * parent. Lets an agent reason about "what happened on this branch" vs. "what happened on a
 * sibling branch forked from the same point," which a flat stream inherently can't represent.
 *
 * Every resolved session's ancestor chain is included automatically (the same way
 * `episodicRecall({branch: "lineage"})` opts into it) — a tree with gaps in its own lineage
 * wouldn't have coherent root nodes.
 *
 * Returns the root branches (sessions with no parent among the resolved set); walk `.children`
 * to reach descendants. Root order and each branch's `children` are sorted by the branch's own
 * first entry timestamp, for a deterministic result.
 */
export async function episodicTree(
  adapter: IStorageAdapter,
  ref: ResourceRef,
  opts: EpisodicTreeOptions = {},
): Promise<EpisodicBranch[]> {
  const resolve = opts.resolveSessions ?? resolveSessionsByResourceId;
  const resolved = await resolve(adapter, ref);
  const sessions = await withAncestors(adapter, resolved);

  const allDetails = await adapter.listAllSandboxDetails();
  const parentBySandboxId = new Map(
    allDetails.map((d) => [d.sandboxId, d.parentSandboxId] as const),
  );

  const branches = new Map<string, EpisodicBranch>();
  for (const session of sessions) {
    const entries = (await adapter.readAll(session.name, session.sandboxId)).sort(
      (a, b) => a.ts - b.ts,
    );
    branches.set(session.sandboxId, {
      sandboxId: session.sandboxId,
      name: session.name,
      parentSandboxId: parentBySandboxId.get(session.sandboxId) ?? undefined,
      entries,
      children: [],
    });
  }

  const roots: EpisodicBranch[] = [];
  for (const branch of branches.values()) {
    const parent = branch.parentSandboxId ? branches.get(branch.parentSandboxId) : undefined;
    if (parent) parent.children.push(branch);
    else roots.push(branch);
  }

  const firstTs = (b: EpisodicBranch) => b.entries[0]?.ts ?? 0;
  const sortRecursively = (list: EpisodicBranch[]): void => {
    list.sort((a, b) => firstTs(a) - firstTs(b));
    for (const branch of list) sortRecursively(branch.children);
  };
  sortRecursively(roots);

  return roots;
}

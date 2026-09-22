/**
 * Quiescence of `subtree(X)` (research/swarm-coordination.md §4, research/tier-1-2-plan.md #4):
 * every member terminal (`done` / `failed` / `aborted` / `lost` — budget-exceeded maps to failed)
 * and none still being spawned. A paused member means not quiescent, and is reported so a stalled
 * wait is visible. A finished-but-open member can be prompted again, so quiescence can flip back —
 * it's a state, not a one-shot event.
 */
import { emit } from "./emit";
import { waitUntil } from "./waitfor";
import { getAgentRow, getHandle, resolveSubtree, runAsOf } from "../state/projection";
import type { QuiescenceView } from "../schema";

const TERMINAL = new Set(["done", "failed", "aborted", "lost"]);

type View = typeof QuiescenceView._zod.output;

export function quiescence(rootId: string): View | null {
  const root = getAgentRow(rootId);
  if (!root) return null;
  const members = resolveSubtree(rootId);
  return {
    rootAgentId: rootId,
    quiescent: members.every((m) => TERMINAL.has(m.state)),
    asOf: runAsOf(root.run_id),
    members: members.map((m) => ({
      agentId: m.agent_id,
      state: m.state,
      outcome: m.outcome,
      resultRef: getHandle(m.agent_id)?.result_ref ?? null,
    })),
    blockedOnPaused: members.filter((m) => m.state === "paused").map((m) => m.agent_id),
  };
}

/** Last quiescence seen per root, so `subtree_quiescent` fires once per transition into it. */
const lastSeen = new Map<string, boolean>();

function observe(view: View, runId: string): void {
  const was = lastSeen.get(view.rootAgentId);
  lastSeen.set(view.rootAgentId, view.quiescent);
  if (view.quiescent && was === false) {
    emit(runId, view.rootAgentId, "run.quiescent", {
      memberCount: view.members.length,
      asOf: view.asOf,
    });
  }
}

/** Hold until the subtree is quiescent or `timeoutMs` passes; returns the view either way. */
export async function waitQuiescent(rootId: string, timeoutMs: number): Promise<View | null> {
  const root = getAgentRow(rootId);
  if (!root) return null;
  const first = quiescence(rootId)!;
  observe(first, root.run_id);
  if (first.quiescent || timeoutMs <= 0) return first;
  return waitUntil(
    root.run_id,
    () => {
      const v = quiescence(rootId)!;
      observe(v, root.run_id);
      return v.quiescent ? v : null;
    },
    { timeoutMs, onTimeout: () => quiescence(rootId)! },
  );
}

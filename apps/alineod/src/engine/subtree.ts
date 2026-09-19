/**
 * Sweeping an operation over `subtree(root)` (research/swarm-control.md §5c): the agent and every
 * descendant, level by level in a chosen direction, members at one depth in parallel. Best-effort:
 * every member gets its own result and one failing doesn't block the rest. Membership is resolved
 * again once after the sweep, so anything spawned into the subtree meanwhile gets the same
 * treatment. Used by pause/resume (pause.ts) and stop (lifecycle.ts).
 */
import { getAgentRow, resolveSubtree, runAsOf, type AgentRow } from "../state/projection";
import { HttpError } from "./errors";
import { SUBTREE_MEMBER_TIMEOUT_MS } from "../../config";
import type { SubtreeOpResult } from "../schema";

export type MemberResult = SubtreeOpResult["results"][number];

export async function sweepSubtree(
  rootId: string,
  order: "parents-first" | "children-first",
  act: (member: AgentRow) => Promise<MemberResult>,
): Promise<SubtreeOpResult> {
  const root = getAgentRow(rootId);
  if (!root) throw new HttpError(404, `no agent ${rootId}`);
  const asOf = runAsOf(root.run_id);
  const results = new Map<string, MemberResult>();

  const sweep = async (members: AgentRow[]) => {
    const depths = [...new Set(members.map((m) => m.depth))].sort((a, b) =>
      order === "parents-first" ? a - b : b - a,
    );
    for (const depth of depths) {
      const level = members.filter((m) => m.depth === depth);
      const done = await Promise.all(level.map((m) => act(m)));
      for (const r of done) results.set(r.agentId, r);
    }
  };

  await sweep(resolveSubtree(rootId));
  const late = resolveSubtree(rootId).filter((m) => !results.has(m.agent_id));
  if (late.length > 0) await sweep(late);

  return { asOf, results: [...results.values()] };
}

/** Run one member's operation, bounded by ALINEOD_SUBTREE_MEMBER_TIMEOUT_MS. */
export async function attempt(
  agentId: string,
  op: () => Promise<string | void>,
): Promise<MemberResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reason = await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout after ${SUBTREE_MEMBER_TIMEOUT_MS}ms`));
        }, SUBTREE_MEMBER_TIMEOUT_MS);
      }),
    ]);
    return reason ? { agentId, outcome: "applied", reason } : { agentId, outcome: "applied" };
  } catch (err) {
    return { agentId, outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

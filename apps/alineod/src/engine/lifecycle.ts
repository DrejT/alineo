/**
 * Stopping agents and tearing down runs. Steer lives in steer.ts, pause/resume in pause.ts.
 *
 * `DELETE /runs/:id` releases live resources but KEEPS the ledger (Q9 — delete is about
 * resources, not history).
 *
 * A finished agent (`done`/`failed`) keeps its sandbox open — promptable, usable as a spawn
 * parent — so stopping or deleting still has to close it, but its recorded outcome stands: that
 * emits `agent_released`, never an `agent_ended` that would rewrite `success` as `aborted`.
 */
import { get, forget } from "./registry";
import { emit } from "./emit";
import { setState } from "./stream";
import { getAgentRow, getRunAgentViews, type AgentRow } from "../state/projection";
import { HttpError } from "./errors";
import { attempt, sweepSubtree, type MemberResult } from "./subtree";
import type { SubtreeOpResult } from "../schema";

/** What a stop did: ended a live agent, released a finished one's sandbox, or nothing. */
export type StopEffect = "aborted" | "released" | "noop";

export async function stopAgent(agentId: string, mode: "abort" | "drain"): Promise<StopEffect> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  const agent = get(agentId);

  if (row.ended_at !== null) {
    if (!agent) return "noop";
    await closeQuietly(agentId);
    emit(row.run_id, agentId, "agent.released", { reason: `stop:${mode}` });
    return "released";
  }

  setState(agentId, "aborted", `stop:${mode}`);
  if (agent) {
    // A frozen bridge can't answer an abort; closing the sandbox is enough.
    if (row.state !== "paused") {
      try {
        await agent.abort();
      } catch {
        /* already stopped */
      }
    }
    await closeQuietly(agentId);
  }
  // No sandbox yet (held on waitFor or a paused parent): ending it here is what cancels the
  // spawn — provisionChild() checks for this before and after the fork.
  emit(row.run_id, agentId, "agent.ended", { outcome: "aborted", endedAt: Date.now() });
  return "aborted";
}

/**
 * Stop an agent and every descendant — leaves first, so no parent is torn down under a child
 * still using it; members at one depth in parallel. Finished members are released (outcome
 * kept), members already ended and closed are skipped.
 */
export async function stopSubtree(
  rootId: string,
  mode: "abort" | "drain",
): Promise<SubtreeOpResult> {
  return sweepSubtree(rootId, "children-first", (m) => stopMember(m, mode));
}

async function stopMember(member: AgentRow, mode: "abort" | "drain"): Promise<MemberResult> {
  const agentId = member.agent_id;
  const row = getAgentRow(agentId) ?? member;
  if (row.ended_at !== null && !get(agentId)) {
    return { agentId, outcome: "skipped", reason: "not-live" };
  }
  return attempt(agentId, async () => {
    const effect = await stopAgent(agentId, mode);
    return effect === "released" ? "released (outcome kept)" : undefined;
  });
}

export async function deleteRun(runId: string): Promise<void> {
  const agents = getRunAgentViews(runId);
  if (agents.length === 0) throw new HttpError(404, `no run ${runId}`);

  for (const a of agents) {
    const agent = get(a.agentId);
    if (!agent) {
      // Not forked yet: ending it cancels the pending spawn (provisionChild checks).
      if (!a.endedAt) {
        emit(runId, a.agentId, "agent.ended", { outcome: "aborted", endedAt: Date.now() });
      }
      continue;
    }
    if (!a.endedAt && a.state !== "paused") {
      try {
        await agent.abort();
      } catch {
        /* ignore */
      }
    }
    await closeQuietly(a.agentId);
    if (a.endedAt) {
      emit(runId, a.agentId, "agent.released", { reason: "delete-run" });
    } else {
      emit(runId, a.agentId, "agent.ended", { outcome: "aborted", endedAt: Date.now() });
    }
  }
  // Ledger is intentionally left intact.
}

async function closeQuietly(agentId: string): Promise<void> {
  const agent = get(agentId);
  if (!agent) return;
  try {
    await agent.close();
  } catch {
    /* already gone */
  }
  forget(agentId);
}

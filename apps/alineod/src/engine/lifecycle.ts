/**
 * Stopping agents and tearing down runs. Steer lives in steer.ts, pause/resume in pause.ts.
 *
 * `DELETE /runs/:id` releases live resources but KEEPS the ledger (Q9 — delete is about
 * resources, not history).
 */
import { get, forget } from "./registry";
import { emit } from "./emit";
import { setState } from "./stream";
import { getAgentRow, getRunAgentViews } from "../state/projection";
import { HttpError } from "./errors";

export async function stopAgent(agentId: string, mode: "abort" | "drain"): Promise<void> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  const agent = get(agentId);

  setState(agentId, "aborted", `stop:${mode}`);

  if (agent) {
    try {
      await agent.abort();
    } catch {
      /* already stopped */
    }
    try {
      await agent.close();
    } catch {
      /* already gone */
    }
    forget(agentId);
  }

  emit(row.run_id, agentId, "agent_ended", { outcome: "aborted", endedAt: Date.now() });
}

export async function deleteRun(runId: string): Promise<void> {
  const agents = getRunAgentViews(runId);
  if (agents.length === 0) throw new HttpError(404, `no run ${runId}`);

  for (const a of agents) {
    const agent = get(a.agentId);
    if (!agent) continue;
    // A finished agent's sandbox stays open (promptable, usable as a spawn parent), so it still
    // has to be closed here — but its recorded outcome stands; only a live one ends as aborted.
    if (!a.endedAt) {
      try {
        await agent.abort();
      } catch {
        /* ignore */
      }
    }
    try {
      await agent.close();
    } catch {
      /* ignore */
    }
    forget(a.agentId);
    if (!a.endedAt) {
      emit(runId, a.agentId, "agent_ended", { outcome: "aborted", endedAt: Date.now() });
    }
  }
  // Ledger is intentionally left intact.
}

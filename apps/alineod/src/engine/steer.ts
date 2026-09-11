/**
 * `POST /agents/:agentId/steer` — inject a message into a currently-running turn, redirecting
 * it without waiting for the turn to finish (unlike `/prompt`'s queued follow-up). A thin
 * wrapper over `Alineo.steer()` — a fire-and-forget ack to the bridge's `/steer` endpoint;
 * Pi's own RPC layer owns what "redirect" actually means turn-to-turn, not alineod — plus a
 * ledger event so it shows up in the audit trail and the SSE stream.
 *
 * Scope: the named agent only. Per research/swarm-control.md §8a, steer never cascades to a
 * subtree by default in this protocol's design; the opt-in `steer(subtree(x))` case (§8a/Q11)
 * isn't in v0 — same boundary as every other verb here (spawn/stop are single-agent too).
 */
import { get } from "./registry";
import { getAgentRow } from "../state/projection";
import { emit } from "./emit";
import { HttpError } from "./errors";

export async function steerAgent(agentId: string, message: string): Promise<void> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);

  const agent = get(agentId);
  if (!agent) throw new HttpError(409, `agent ${agentId} is not live (cannot steer it)`);

  try {
    await agent.steer(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `steer failed: ${msg}`);
  }

  emit(row.run_id, agentId, "agent_steered", { message });
}

/**
 * `POST /agents/:id/pause` / `POST /agents/:id/resume` — freeze/unfreeze the agent's
 * underlying OpenSandbox container. Thin wrappers over `agent.sandbox.pause()`/`.resume()` —
 * the substrate primitive `@alineo-labs/core`'s `SandboxHandle` already implements; alineod
 * just gates it on liveness and records the state transition.
 *
 * On Docker (this environment), it's a real freeze/thaw: the container — and the Pi process
 * / bridge inside it — is suspended in place and continues exactly where it left off on
 * resume. Any in-flight turn's SSE stream just stalls for the duration (no bytes arrive while
 * paused) rather than erroring, though a pause longer than `PROMPT_INACTIVITY_TIMEOUT_MS`
 * will still trip that stall timeout once resumed, same as any other stall. On Kubernetes,
 * `@alineo-labs/core`'s own docs note pause/resume is snapshot-based instead — in-memory
 * state does not survive.
 *
 * v0 scope (research/swarm-control.md has the fuller design — `pausedBy` provenance,
 * cascade-to-subtree, etc.): operator-only, the named agent only, no cascade. Resume always
 * restores state to "running" rather than whatever it was before pause — correct for the
 * common case (pausing a running agent) and a harmless label inaccuracy for the rare one
 * (pausing an already-finished agent's still-idle sandbox).
 */
import { get } from "./registry";
import { getAgentRow } from "../state/projection";
import { emit } from "./emit";
import { HttpError } from "./errors";

export async function pauseAgent(agentId: string): Promise<void> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  if (row.state === "paused") return; // idempotent

  const agent = get(agentId);
  if (!agent) throw new HttpError(409, `agent ${agentId} is not live (cannot pause it)`);

  try {
    await agent.sandbox.pause();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `pause failed: ${msg}`);
  }

  emit(row.run_id, agentId, "agent_state_changed", { from: row.state, to: "paused", reason: "operator" });
}

export async function resumeAgent(agentId: string): Promise<void> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  if (row.state !== "paused") {
    throw new HttpError(409, `agent ${agentId} is not paused (state: ${row.state})`);
  }

  const agent = get(agentId);
  if (!agent) throw new HttpError(409, `agent ${agentId} is not live (cannot resume it)`);

  try {
    await agent.sandbox.resume();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `resume failed: ${msg}`);
  }

  emit(row.run_id, agentId, "agent_state_changed", { from: "paused", to: "running", reason: "operator" });
}

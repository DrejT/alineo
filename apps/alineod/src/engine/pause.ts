/**
 * `POST /agents/:id/pause` / `POST /agents/:id/resume` — freeze/unfreeze the agent's
 * underlying OpenSandbox container. Thin wrappers over `agent.sandbox.pause()`/`.resume()` —
 * the substrate primitive `@alineo-labs/core`'s `SandboxHandle` already implements; alineod
 * gates it on liveness and records the state transition.
 *
 * On Docker, it's a real freeze/thaw: the container — and the Pi process / bridge inside it —
 * is suspended in place and continues exactly where it left off on resume (verified live,
 * research/subtree-controls-verification.md V2c). A pause never ends a turn: if the stream's
 * inactivity timeout fires meanwhile, stream.ts follows the turn by polling instead, and paused
 * time doesn't count toward that. On Kubernetes, `@alineo-labs/core`'s own docs note
 * pause/resume is snapshot-based instead — in-memory state does not survive.
 *
 * Scope (research/swarm-control.md has the fuller design — `pausedBy` provenance,
 * cascade-to-subtree, etc.): operator-only, the named agent only, no cascade. Resume restores
 * the state the agent had before the pause (`paused_from`).
 */
import { Alineo } from "alineo";
import { get, register, sdkAdapter } from "./registry";
import { getAgentRow } from "../state/projection";
import { emit } from "./emit";
import { catchUpTurn, isTurnActive } from "./stream";
import { HttpError } from "./errors";
import { withTimeout } from "../util";
import { RESUME_BRIDGE_TIMEOUT_MS } from "../../config";

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

  emit(row.run_id, agentId, "agent_state_changed", {
    from: row.state,
    to: "paused",
    reason: "operator",
  });
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

  const pausedFrom = row.paused_from ?? "running";
  emit(row.run_id, agentId, "agent_state_changed", {
    from: "paused",
    to: pausedFrom,
    reason: "operator",
  });

  // An agent reconnected while paused (after a restart) was registered without probing its
  // bridge — a frozen bridge can't answer (rehydrate.ts). Check it now that the container runs.
  const bridgeOk = await withTimeout(
    agent.adapter.waitReady(RESUME_BRIDGE_TIMEOUT_MS).then(() => true),
    RESUME_BRIDGE_TIMEOUT_MS + 1_000,
  );
  if (!bridgeOk) {
    try {
      const restarted = await Alineo.resume(agent.sandboxId, {
        adapter: sdkAdapter,
        spec: JSON.parse(row.spec_json),
        runId: row.run_id,
      });
      register(agentId, restarted);
      console.log(`[alineod] ${agentId}: bridge didn't answer after resume — restarted it`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (row.ended_at === null) {
        emit(row.run_id, agentId, "agent_ended", {
          outcome: "lost",
          endedAt: Date.now(),
          error: `bridge did not come back after resume: ${msg}`,
        });
      }
      throw new HttpError(502, `resumed, but the agent's bridge did not come back: ${msg}`);
    }
  }

  // A turn that was running when the agent was paused, and that nothing is following any more
  // (alineod restarted while it was paused), is followed by polling until it finishes.
  if (pausedFrom === "running" && !isTurnActive(agentId)) {
    void catchUpTurn(row.run_id, agentId, { afterStream: true });
  }
}

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
 * Scope: `pauseAgent`/`resumeAgent` act on the named agent; `pauseSubtree`/`resumeSubtree` act on it
 * and every descendant (research/swarm-control.md §5c, §6). Resume restores the state the agent had
 * before the pause (`paused_from`). Each pause records who caused it (`paused_by`): `operator` for the
 * target of the call, `cascade` for a descendant a subtree pause reached.
 */
import { Alineo } from "alineo";
import { get, register, sdkAdapter } from "./registry";
import { getAgentRow, getHandle, type AgentRow } from "../state/projection";
import { attempt, sweepSubtree, type MemberResult } from "./subtree";
import { emit } from "./emit";
import { catchUpTurn, driveTurn, isTurnActive } from "./stream";
import { deliverPending, withInbox } from "./notify";
import { HttpError } from "./errors";
import { errorMessage, withTimeout } from "../util";
import { RESUME_BRIDGE_TIMEOUT_MS } from "../../config";
import type { SubtreeOpResult } from "../schema";
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("alineod");

export type PausedBy = "operator" | "cascade";

export async function pauseAgent(
  agentId: string,
  opts: { pausedBy?: PausedBy } = {},
): Promise<void> {
  const pausedBy = opts.pausedBy ?? "operator";
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  if (row.state === "paused") return; // idempotent

  const agent = get(agentId);
  if (!agent) throw new HttpError(409, `agent ${agentId} is not live (cannot pause it)`);

  try {
    await agent.sandbox.pause();
  } catch (err) {
    const msg = errorMessage(err);
    throw new HttpError(502, `pause failed: ${msg}`);
  }

  emit(row.run_id, agentId, "agent.state_changed", {
    from: row.state,
    to: "paused",
    reason: pausedBy,
    pausedBy,
  });
}

export async function resumeAgent(agentId: string, opts: { by?: PausedBy } = {}): Promise<void> {
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
    const msg = errorMessage(err);
    throw new HttpError(502, `resume failed: ${msg}`);
  }

  const pausedFrom = row.paused_from ?? "running";
  emit(row.run_id, agentId, "agent.state_changed", {
    from: "paused",
    to: pausedFrom,
    reason: opts.by ?? "operator",
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
      log.info("bridge didn't answer after resume — restarted it", { agentId });
    } catch (err) {
      const msg = errorMessage(err);
      if (row.ended_at === null) {
        emit(row.run_id, agentId, "agent.ended", {
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

  // A child that forked while an ancestor was paused joined the pause before its first prompt ran
  // (spawn.ts) — start that prompt now.
  if (
    pausedFrom === "provisioning" &&
    row.prompt &&
    getHandle(agentId)?.state === "pending" &&
    !isTurnActive(agentId)
  ) {
    void driveTurn(agentId, withInbox(agentId, row.prompt));
  }

  // Anything that arrived for it while it was paused (notifications, a queued subtree steer).
  void deliverPending(agentId);
}

// ── subtree scope ─────────────────────────────────────────────────────────────

const CLOSED_STATES = new Set(["aborted", "lost"]);

/**
 * Pause an agent and every descendant — parents first, so a parent stops spawning before its
 * children freeze; members at one depth in parallel. Best-effort: every member gets its own
 * result, and one failing doesn't stop the rest. A member that hasn't forked yet can't be frozen;
 * it joins the pause as soon as it forks (spawn.ts), so it's reported `applied` with a reason.
 * Membership is resolved again once after the sweep, to catch agents spawned during it.
 */
export async function pauseSubtree(rootId: string): Promise<SubtreeOpResult> {
  return sweepSubtree(rootId, "parents-first", (m) =>
    pauseMember(m, m.agent_id === rootId ? "operator" : "cascade", m.agent_id === rootId),
  );
}

/**
 * Resume an agent and every paused descendant — children first, the target last, so a parent
 * wakes into a subtree that's already moving. Lifts `operator` and `cascade` pauses; anything
 * not paused is skipped.
 */
export async function resumeSubtree(rootId: string): Promise<SubtreeOpResult> {
  return sweepSubtree(rootId, "children-first", (m) =>
    resumeMember(m, m.agent_id === rootId ? "operator" : "cascade"),
  );
}

async function pauseMember(
  member: AgentRow,
  pausedBy: PausedBy,
  isRoot: boolean,
): Promise<MemberResult> {
  const agentId = member.agent_id;
  const row = getAgentRow(agentId) ?? member;
  if (row.state === "paused") return { agentId, outcome: "skipped", reason: "already-paused" };
  if (CLOSED_STATES.has(row.state)) return { agentId, outcome: "skipped", reason: "not-live" };
  if (!row.sandbox_id) {
    return isRoot
      ? { agentId, outcome: "skipped", reason: "not-provisioned" }
      : { agentId, outcome: "applied", reason: "pending: pauses as soon as it forks" };
  }
  if (!get(agentId)) return { agentId, outcome: "skipped", reason: "not-live" };
  return attempt(agentId, () => pauseAgent(agentId, { pausedBy }));
}

async function resumeMember(member: AgentRow, by: PausedBy): Promise<MemberResult> {
  const agentId = member.agent_id;
  const row = getAgentRow(agentId) ?? member;
  if (row.state !== "paused") return { agentId, outcome: "skipped", reason: "not-paused" };
  if (row.paused_by && row.paused_by !== "operator" && row.paused_by !== "cascade") {
    return { agentId, outcome: "skipped", reason: `paused-by-${row.paused_by}` };
  }
  return attempt(agentId, () => resumeAgent(agentId, { by }));
}

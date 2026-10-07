/**
 * Stopping agents and tearing down runs. Steer lives in steer.ts, pause/resume in pause.ts.
 *
 * `DELETE /runs/:id` releases live resources but KEEPS the ledger (Q9 — delete is about
 * resources, not history).
 *
 * A finished agent (`done`/`failed`) keeps its sandbox open — promptable, usable as a spawn
 * parent — so stopping or deleting still has to close it, but its recorded outcome stands: that
 * emits `agent_released`, never an `agent_ended` that would rewrite `success` as `aborted`.
 *
 * `stopAgent` runs under `withAgentLock` (agent-lock.ts, shared with pause.ts) — it reads state,
 * then awaits `agent.abort()`/`.close()`, so a concurrent pause/resume/stop on the same agent
 * must not interleave with it either.
 *
 * `finalizeRun` (plans/07-10-2026/close-when.md §3.5) is the shared release half of closing a
 * run — every member is already terminal by the time it's called, whether because a client's
 * `DELETE` just aborted whatever was still live, or because `closeWhen: "quiescent"` means
 * nothing ever needed aborting. It is also the reactive trigger's target: the `onEmit` listener
 * at the bottom of this file calls it the moment a `closeWhen: "quiescent"` run's subtree goes
 * quiescent, with no client call at all.
 */
import { get, forget } from "./registry";
import { emit, onEmit } from "./emit";
import { setState } from "./stream";
import {
  getAgentRow,
  getRun,
  getRunAgentViews,
  getRunRoot,
  claimRunClose,
  type AgentRow,
} from "../state/projection";
import { withAgentLock } from "./agent-lock";
import { withIdempotency } from "./idempotency";
import { HttpError } from "./errors";
import { attempt, sweepSubtree, type MemberResult } from "./subtree";
import { quiescence } from "./quiescence";
import type { SubtreeOpResult } from "../schema";

/** What a stop did: ended a live agent, released a finished one's sandbox, or nothing. */
export type StopEffect = "aborted" | "released" | "noop";

export function stopAgent(
  agentId: string,
  mode: "abort" | "drain",
  opts: { idempotencyKey?: string } = {},
): Promise<StopEffect> {
  return withAgentLock(agentId, () =>
    withIdempotency(agentId, "stop", opts.idempotencyKey, async () => {
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
    }),
  );
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

  // Make everyone terminal first — abort whatever is still live. A member that's already
  // ended (including one a prior DELETE or an auto-close already finished) is left alone, so
  // a second DELETE on an already-closed run is a clean no-op, not a double abort.
  for (const a of agents) {
    if (a.endedAt) continue;
    const agent = get(a.agentId);
    if (agent && a.state !== "paused") {
      try {
        await agent.abort();
      } catch {
        /* ignore */
      }
    }
    // Not forked yet (no agent in the registry): ending it cancels the pending spawn
    // (provisionChild checks). Already live: this is what turns it into "aborted".
    emit(runId, a.agentId, "agent.ended", { outcome: "aborted", endedAt: Date.now() });
  }

  await finalizeRun(runId, "explicit");
}

/**
 * Release every member's still-open sandbox and emit `run.closed` — the shared second half of
 * closing a run, reached either from `deleteRun` above (after it's finished aborting whatever
 * was live) or reactively from the `onEmit` listener below. By the time this runs, every member
 * is terminal by construction: `deleteRun` just ensured it, and the quiescent trigger only ever
 * fires when `quiescence()` already said so.
 *
 * `claimRunClose` is the one-shot guard: it atomically flips `runs.state` from open to closed,
 * so a second call for the same run (a retried DELETE racing an auto-close, or vice versa) is a
 * clean no-op rather than a double release or a second `run.closed`.
 */
async function finalizeRun(runId: string, reason: "explicit" | "quiescent"): Promise<void> {
  if (!claimRunClose(runId)) return;
  for (const a of getRunAgentViews(runId)) {
    // Not terminal: unreachable in practice (every trigger path only calls this once every
    // member already is), kept as a defensive skip rather than an assertion. Not registered:
    // already released by something else (e.g. a direct stopAgent() call on the run's last
    // live member, right before this run's own reactive trigger saw the same event) — closing
    // it again would be a no-op, but emitting a second `agent.released` for it would not be.
    if (!a.endedAt || !get(a.agentId)) continue;
    await closeQuietly(a.agentId);
    emit(runId, a.agentId, "agent.released", { reason: `run-${reason}-close` });
  }
  emit(runId, null, "run.closed", { reason });
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

/**
 * The reactive half of `closeWhen: "quiescent"` (plans/07-10-2026/close-when.md §3.4):
 * whenever an event could flip a subtree's quiescence, check whether this run opted into
 * auto-close and, if so, whether its root subtree is now quiescent.
 *
 * Deliberately `inbox.dropped`, not `inbox.delivered`: a drop means a stale notification to an
 * already-closed recipient was discarded — its pendingInbox count can only go to zero. A
 * delivery is the opposite signal whenever it's `as: "turn"` — an idle member just got woken
 * into a *new* turn, so it is about to stop being terminal, not become quiescent. Checking
 * right on that event raced against the turn it was about to start: `quiescence()` could read
 * "pendingInbox now empty, state still done" in the gap before `agent.state_changed` to
 * "running" lands, and incorrectly close the run out from under a turn that had already begun.
 * That turn's own eventual `agent.ended` is what correctly re-triggers this once it finishes —
 * no separate case is needed for it. `as: "steer"` needs nothing either: steering only reaches
 * a member that's already running, which was never terminal to begin with.
 *
 * Listening here rather than importing this module from emit.ts keeps the engine imports
 * acyclic — the same call notify.ts's own `onEmit` registrations make.
 *
 * `finalizeRun` is only ever reached here through an `await` first (`closeQuietly` inside its
 * loop) — by the time it calls `emit()` itself, this listener's own `emit()` call has long
 * since returned, so there's no reentrant call into `emit()` from inside its own post-fold
 * step. `void` (not awaited) is still the right shape: a listener runs synchronously inside
 * `emit()`, and nothing here is on the critical path of the event that triggered it.
 */
const QUIESCENCE_RELEVANT = new Set(["agent.ended", "agent.released", "inbox.dropped"]);

onEmit((runId, _agentId, event) => {
  if (!QUIESCENCE_RELEVANT.has(event)) return;
  const run = getRun(runId);
  if (!run || run.state !== "open" || run.close_when !== "quiescent") return;
  const root = getRunRoot(runId);
  if (!root) return;
  if (quiescence(root.agent_id)?.quiescent) void finalizeRun(runId, "quiescent");
});

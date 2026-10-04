/**
 * Crash-only recovery (research/daemon.md §3). On boot:
 *
 *   1. rebuild the `agents` / `handles` projections from the ledger.
 *   2. Pass 1 — every live agent that already has a sandbox, PLUS every finished agent whose
 *      sandbox is still open (`reconnectableTerminalAgents()` — a `done`/`failed` turn does not
 *      close the sandbox, so it stays promptable / usable as a spawn parent, and a fresh
 *      process needs its own connection object for that to keep working post-restart):
 *      `Alineo.reattach()` (preserves the bridge, see D-a), falling back to `Alineo.resume()`
 *      (restarts it) if that fails. An agent that was mid-turn at crash time gets a background
 *      catch-up poll (`catchUpTurn`) either way, so its handle still settles — once Pi finishes
 *      if the bridge was preserved, at once if it had to be restarted (the turn died with it).
 *      Otherwise the projection would say "running" forever.
 *   3. Pass 2 — every live agent still stuck *before* its fork (no sandbox yet: a child
 *      queued behind `waitFor`, or a root still inside `Alineo.start()`): retry the spawn
 *      from what was persisted in its `agent_spawned` event (`wait_for`/`prompt` in db.ts —
 *      before this existed, that intent only ever lived in the dead process's closure, so
 *      it was unconditionally marked "lost"). Only possible if the parent came back in pass
 *      1 (or is itself a retried root); anything else really is unrecoverable.
 */
import { Alineo, isSandboxGone } from "alineo";
import {
  rebuild,
  liveAgents,
  reconnectableTerminalAgents,
  agentsWithPendingInbox,
  type AgentRow,
} from "../state/projection";
import { sdkAdapter, register, get } from "./registry";
import { emit } from "./emit";
import { catchUpTurn } from "./stream";
import { provisionRoot } from "./runs";
import { provisionChild, injectInputs } from "./spawn";
import { deliverPending } from "./notify";
import { parseStoredWait, evaluateWait } from "./waitfor";
import type { CreateRunBody, SpawnAgentBody } from "../schema";
import { getLogger } from "@alineo-labs/logger";
import { errorMessage } from "../util";
import { REATTACH_RETRY_DELAY_MS } from "../../config";

const log = getLogger("alineod");

export async function rehydrate(): Promise<void> {
  rebuild();

  const live = liveAgents();
  const finished = reconnectableTerminalAgents();
  if (live.length === 0 && finished.length === 0) return;

  const withSandbox = live.filter((a) => a.sandbox_id);
  const preFork = live.filter((a) => !a.sandbox_id).sort((a, b) => a.depth - b.depth);

  // A pre-fork agent's parent may have already finished its OWN turn by crash time (a terminal
  // outcome, e.g. "done") while its sandbox is still sitting there, needed as pass 2's fork
  // source — `finished` already covers exactly that case, so no separate lookup is needed here.
  const reattachSet = new Map(withSandbox.map((a) => [a.agent_id, a]));
  for (const a of finished) reattachSet.set(a.agent_id, a);

  log.info("rehydrating", {
    live: live.length,
    finishedButOpen: finished.length,
    toReconnect: reattachSet.size,
    preFork: preFork.length,
  });

  // Pass 1 — awaited: fast (~100-200ms each, verified live) unless a reattach needs its one retry
  // (REATTACH_RETRY_DELAY_MS, only on a failed first attempt), and pass 2 needs these parents
  // registered before it can retry a spawn under them.
  for (const a of reattachSet.values()) await reattachOne(a);

  // Pass 2 — fire-and-backgrounded, same as a fresh spawn: the slow part (an optional waitFor
  // hold, then the fork) shouldn't block the daemon from coming back up and serving requests.
  for (const a of preFork) void retryProvision(a);

  // Notifications that were queued but not yet delivered when the previous process died.
  for (const id of agentsWithPendingInbox()) void deliverPending(id);
}

/**
 * durability-roadmap M3, 3.4: both `Alineo.reattach()` and `Alineo.resume()` can now return a
 * *different* sandboxId than the one requested — 3.3 gave both the same restore-from-checkpoint
 * fallback for when the original container is gone entirely, not just unreachable. Either
 * success path needs the same two follow-ups, so this is called from both of `reattachOne()`'s
 * try blocks rather than duplicated (duplicating it once already produced the real bug this
 * comment is describing — found live on `my-vps`, 2026-10-04: the `reattach()` path restored
 * successfully but the then-only-on-resume() check never ran for it, leaving its persisted
 * `sandbox_id` pointing at the deleted container forever).
 */
async function onContainerRestored(
  a: AgentRow,
  agent: Alineo,
  verb: "reattached" | "resumed",
): Promise<void> {
  if (agent.sandboxId === a.sandbox_id) {
    log.info(`${verb} — bridge preserved`, { agentId: a.agent_id, sandboxId: a.sandbox_id });
    return;
  }
  // The persisted row must learn about the new sandboxId -- otherwise it keeps pointing at a
  // deleted sandbox, and every future boot repeats the same restore from the same stale
  // checkpoint instead of building on the one that's now actually running.
  emit(a.run_id, a.agent_id, "agent.provisioned", { sandboxId: agent.sandboxId });
  log.info(`${verb} — container was gone, restored onto a new one`, {
    agentId: a.agent_id,
    oldSandboxId: a.sandbox_id,
    newSandboxId: agent.sandboxId,
  });
  // The restored container came from the shared setup snapshot, which predates this agent's
  // own waitFor inputs (/inputs/*.txt, /inputs.json) -- those live under `/`, not `/root`, so
  // the turn checkpoint never captured them either. Re-derive the same dependency selection the
  // original wait already settled on (evaluateWait is pure over the dependencies' own
  // already-settled handles) and re-write them, same as a brand-new child's first provision
  // does.
  const wait = parseStoredWait(a.wait_for);
  const waited = wait ? evaluateWait(wait) : null;
  if (wait && waited) await injectInputs(agent, wait, waited);
}

async function reattachOne(a: AgentRow): Promise<void> {
  const spec = JSON.parse(a.spec_json);
  const opts = { adapter: sdkAdapter, spec, runId: a.run_id };
  const wasRunning = a.state === "running";

  if (a.state === "paused") {
    await reattachPaused(a, opts);
    return;
  }

  try {
    const agent = await reattachWithRetry(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    // durability-roadmap M3, 3.4 (bug found live on my-vps, 2026-10-04: a real container
    // deletion restored successfully through THIS branch, not just the resume() branch below
    // -- 3.3 added the same restore-from-checkpoint fallback to Alineo.reattach() too, and the
    // first version of this fix only checked for it after resume(), leaving reattach's own
    // restored agents with a stale persisted sandbox_id forever). Same check, same fix, both
    // branches -- see onContainerRestored's own comment.
    await onContainerRestored(a, agent, "reattached");
    if (wasRunning) {
      emit(a.run_id, a.agent_id, "agent.turn_interrupted", {});
      void catchUpTurn(a.run_id, a.agent_id);
    }
    return;
  } catch (reattachErr) {
    log.warn("reattach failed (after retry) — falling back to resume", {
      agentId: a.agent_id,
      error: errorMessage(reattachErr),
    });
  }

  try {
    const agent = await Alineo.resume(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    await onContainerRestored(a, agent, "resumed");
    // The turn that was running died with the old bridge process, and nothing is following it:
    // catch-up sees the new (idle) bridge, records whatever text survived, and settles the handle.
    if (wasRunning) {
      emit(a.run_id, a.agent_id, "agent.turn_interrupted", {});
      void catchUpTurn(a.run_id, a.agent_id);
    }
  } catch (err) {
    const message = errorMessage(err);
    // An agent that had already ended (this is the "finished-but-open" reconnect case, not the
    // live one) keeps its real outcome — a failed reconnect only means it can't be prompted or
    // spawned-from again THIS boot, not that its already-recorded, already-settled turn is now
    // "lost". Only a still-live agent's outcome is genuinely unknown and worth overwriting.
    if (a.ended_at === null) {
      emit(a.run_id, a.agent_id, "agent.ended", {
        outcome: "lost",
        endedAt: Date.now(),
        error: message,
      });
      log.warn("lost", { agentId: a.agent_id, error: message });
    } else if (isSandboxGone(err)) {
      // Not "unreachable this boot" but gone for good (deleted, reaped, or lost with its host).
      // Record the release so the agent stops claiming to be promptable, and so no later boot
      // tries to reconnect it again. The outcome still stands.
      emit(a.run_id, a.agent_id, "agent.released", { reason: "sandbox-missing" });
      log.warn("sandbox gone — released; its recorded outcome stands", {
        agentId: a.agent_id,
        sandboxId: a.sandbox_id,
        outcome: a.outcome,
      });
    } else {
      log.warn("unreachable — its recorded outcome stands", {
        agentId: a.agent_id,
        sandboxId: a.sandbox_id,
        error: message,
        outcome: a.outcome,
      });
    }
  }
}

/**
 * One retry, after a short delay, before `reattachOne` falls back to `resume()`. Observed live on
 * a VPS run of `swarm-reattach-test.py` (durability-roadmap M0.2, 2026-10-01): a just-checkpointed
 * sandbox was momentarily reported `Paused` by OpenSandbox at the exact instant alineod reattached
 * to it, and had cleared back to `Running` about a second later. Without this retry, that one
 * transient error reads as "parent unreachable" and cascades to every still-pending child of that
 * parent being marked `lost` in `retryProvision` below — a false pessimism, not a real loss.
 *
 * Skips the retry when the sandbox is gone for good (`isSandboxGone`): waiting doesn't help a
 * deleted container, so that case fails fast into the existing resume/lost fallback below.
 */
async function reattachWithRetry(
  sandboxId: string,
  opts: { adapter: typeof sdkAdapter; spec: unknown; runId: string },
): Promise<Awaited<ReturnType<typeof Alineo.reattach>>> {
  const reattachOpts = { ...opts, spec: opts.spec as Record<string, unknown> };
  try {
    return await Alineo.reattach(sandboxId, reattachOpts);
  } catch (err) {
    if (isSandboxGone(err)) throw err;
    // Previously silent -- found live on my-vps, 2026-10-04: a transient failure here (the
    // first attempt of a restore-from-checkpoint, 3.3, failing partway through after already
    // provisioning a fresh container) retried invisibly, with no log line distinguishing it
    // from a normal first-try success. Log it so a future occurrence is visible instead of
    // only inferable from two separate fresh sandboxIds appearing in the ledger.
    log.warn("reattach failed, retrying once", { sandboxId, error: errorMessage(err) });
    await Bun.sleep(REATTACH_RETRY_DELAY_MS);
    return await Alineo.reattach(sandboxId, reattachOpts);
  }
}

// durability-roadmap M3, 3.3/3.4: promoted to packages/agent/src/sandbox-gone.ts, which also
// resumeAgent()/reattachAgent() need (same question, same answer) — and extended there to also
// recognize an Exited-after-reboot container (a 200 OK with state Terminated/Failed, not a
// 404), which this file's own private copy never covered. See that file's doc comment.

/**
 * A paused agent's container is frozen, so its bridge can't answer the usual ready probe — and
 * falling back to `Alineo.resume()` would try to restart the bridge inside the frozen container
 * and mark the agent `lost`. Reconnect without probing and leave it paused; `resumeAgent()`
 * checks the bridge (and restarts it if needed) and catches up any turn once it's resumed.
 */
async function reattachPaused(
  a: AgentRow,
  opts: { adapter: typeof sdkAdapter; spec: unknown; runId: string },
): Promise<void> {
  try {
    const agent = await Alineo.reattach(a.sandbox_id!, {
      ...opts,
      spec: opts.spec as Record<string, unknown>,
      skipReadyCheck: true,
    });
    register(a.agent_id, agent);
    log.info("reattached — paused, bridge not probed", {
      agentId: a.agent_id,
      sandboxId: a.sandbox_id,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (a.ended_at === null) {
      emit(a.run_id, a.agent_id, "agent.ended", {
        outcome: "lost",
        endedAt: Date.now(),
        error: message,
      });
      log.warn("lost (paused)", { agentId: a.agent_id, error: message });
    } else {
      log.warn("unreachable (paused) — its recorded outcome stands", {
        agentId: a.agent_id,
        sandboxId: a.sandbox_id,
        error: message,
        outcome: a.outcome,
      });
    }
  }
}

async function retryProvision(a: AgentRow): Promise<void> {
  const spec = JSON.parse(a.spec_json);

  if (!a.parent_agent_id) {
    log.info("retrying provision for root (was still inside Alineo.start())", {
      agentId: a.agent_id,
    });
    const body: CreateRunBody = {
      spec,
      prompt: a.prompt ?? undefined,
      budget: {
        spawnDepth: a.spawn_budget ?? undefined,
        maxAgents: a.max_agents_budget ?? undefined,
      },
    };
    await provisionRoot(a.run_id, a.agent_id, body);
    return;
  }

  const parent = get(a.parent_agent_id);
  if (!parent) {
    emit(a.run_id, a.agent_id, "agent.ended", {
      outcome: "lost",
      endedAt: Date.now(),
      error: `parent ${a.parent_agent_id} did not come back — cannot retry this spawn`,
    });
    log.warn("lost: parent unavailable", {
      agentId: a.agent_id,
      parentAgentId: a.parent_agent_id,
    });
    return;
  }

  log.info("retrying provision (parent is live)", {
    agentId: a.agent_id,
    parentAgentId: a.parent_agent_id,
  });
  const body: SpawnAgentBody = {
    spec,
    parentAgentId: a.parent_agent_id,
    prompt: a.prompt ?? undefined,
  };
  await provisionChild(
    a.run_id,
    a.agent_id,
    a.parent_agent_id,
    a.spawn_budget ?? undefined,
    a.max_agents_budget ?? undefined,
    body,
    parseStoredWait(a.wait_for),
  );
}

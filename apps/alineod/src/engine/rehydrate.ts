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
 *      queued behind `waitFor`, or a root still inside `Alineo.load()`): retry the spawn
 *      from what was persisted in its `agent_spawned` event (`wait_for`/`prompt` in db.ts —
 *      before this existed, that intent only ever lived in the dead process's closure, so
 *      it was unconditionally marked "lost"). Only possible if the parent came back in pass
 *      1 (or is itself a retried root); anything else really is unrecoverable.
 */
import { Alineo } from "alineo";
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
import { provisionChild } from "./spawn";
import { deliverPending } from "./notify";
import { parseStoredWait } from "./waitfor";
import type { CreateRunBody, SpawnAgentBody } from "../schema";
import { getLogger } from "@alineo-labs/logger";

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

  // Pass 1 — awaited: fast (~100-200ms each, verified live), and pass 2 needs these parents
  // registered before it can retry a spawn under them.
  for (const a of reattachSet.values()) await reattachOne(a);

  // Pass 2 — fire-and-backgrounded, same as a fresh spawn: the slow part (an optional waitFor
  // hold, then the fork) shouldn't block the daemon from coming back up and serving requests.
  for (const a of preFork) void retryProvision(a);

  // Notifications that were queued but not yet delivered when the previous process died.
  for (const id of agentsWithPendingInbox()) void deliverPending(id);
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
    const agent = await Alineo.reattach(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    log.info("reattached — bridge preserved", { agentId: a.agent_id, sandboxId: a.sandbox_id });
    if (wasRunning) void catchUpTurn(a.run_id, a.agent_id);
    return;
  } catch (reattachErr) {
    log.warn("reattach failed — falling back to resume", {
      agentId: a.agent_id,
      error: describeError(reattachErr),
    });
  }

  try {
    const agent = await Alineo.resume(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    log.info("resumed — bridge restarted", { agentId: a.agent_id, sandboxId: a.sandbox_id });
    // The turn that was running died with the old bridge process, and nothing is following it:
    // catch-up sees the new (idle) bridge, records whatever text survived, and settles the handle.
    if (wasRunning) void catchUpTurn(a.run_id, a.agent_id);
  } catch (err) {
    const message = describeError(err);
    // An agent that had already ended (this is the "finished-but-open" reconnect case, not the
    // live one) keeps its real outcome — a failed reconnect only means it can't be prompted or
    // spawned-from again THIS boot, not that its already-recorded, already-settled turn is now
    // "lost". Only a still-live agent's outcome is genuinely unknown and worth overwriting.
    if (a.ended_at === null) {
      emit(a.run_id, a.agent_id, "agent_ended", {
        outcome: "lost",
        endedAt: Date.now(),
        error: message,
      });
      log.warn("lost", { agentId: a.agent_id, error: message });
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
    const message = describeError(err);
    if (a.ended_at === null) {
      emit(a.run_id, a.agent_id, "agent_ended", {
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
    log.info("retrying provision for root (was still inside Alineo.load())", {
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
    emit(a.run_id, a.agent_id, "agent_ended", {
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

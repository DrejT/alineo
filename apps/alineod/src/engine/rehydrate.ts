/**
 * Crash-only recovery (research/daemon.md §3). On boot:
 *
 *   1. rebuild the `agents` / `handles` projections from the ledger.
 *   2. Pass 1 — every live agent that already has a sandbox: `Alineo.reattach()` (preserves
 *      the bridge, see D-a), falling back to `Alineo.resume()` (restarts it) if that fails.
 *      A reattached agent that was mid-turn at crash time gets a background catch-up poll
 *      (`catchUpTurn`) so its handle still settles once Pi finishes — otherwise the
 *      projection would say "running" forever even though the turn is long done.
 *   3. Pass 2 — every live agent still stuck *before* its fork (no sandbox yet: a child
 *      queued behind `waitFor`, or a root still inside `Alineo.load()`): retry the spawn
 *      from what was persisted in its `agent_spawned` event (`wait_for`/`prompt` in db.ts —
 *      before this existed, that intent only ever lived in the dead process's closure, so
 *      it was unconditionally marked "lost"). Only possible if the parent came back in pass
 *      1 (or is itself a retried root); anything else really is unrecoverable.
 */
import { Alineo } from "alineo";
import { rebuild, liveAgents, type AgentRow } from "../state/projection";
import { sdkAdapter, register, get } from "./registry";
import { emit } from "./emit";
import { catchUpTurn } from "./stream";
import { provisionRoot } from "./runs";
import { provisionChild } from "./spawn";
import type { CreateRunBody, SpawnAgentBody } from "../schema";

export async function rehydrate(): Promise<void> {
  rebuild();

  const live = liveAgents();
  if (live.length === 0) return;

  const withSandbox = live.filter((a) => a.sandbox_id);
  const preFork = live.filter((a) => !a.sandbox_id).sort((a, b) => a.depth - b.depth);

  console.log(
    `[alineod] rehydrating ${live.length} live agent(s) — ${withSandbox.length} with a sandbox, ${preFork.length} still pre-fork...`,
  );

  // Pass 1 — awaited: fast (~100-200ms each, verified live), and pass 2 needs these parents
  // registered before it can retry a spawn under them.
  for (const a of withSandbox) await reattachOne(a);

  // Pass 2 — fire-and-backgrounded, same as a fresh spawn: the slow part (an optional waitFor
  // hold, then the fork) shouldn't block the daemon from coming back up and serving requests.
  for (const a of preFork) void retryProvision(a);
}

async function reattachOne(a: AgentRow): Promise<void> {
  const spec = JSON.parse(a.spec_json);
  const opts = { adapter: sdkAdapter, spec, runId: a.run_id };
  const wasRunning = a.state === "running";

  try {
    const agent = await Alineo.reattach(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    console.log(`[alineod]   reattached ${a.agent_id} (${a.sandbox_id}) — bridge preserved`);
    if (wasRunning) void catchUpTurn(a.run_id, a.agent_id);
    return;
  } catch (reattachErr) {
    console.log(
      `[alineod]   reattach failed for ${a.agent_id} (${describeError(reattachErr)}) — falling back to resume`,
    );
  }

  try {
    const agent = await Alineo.resume(a.sandbox_id!, opts);
    register(a.agent_id, agent);
    console.log(`[alineod]   resumed ${a.agent_id} (${a.sandbox_id}) — bridge restarted`);
  } catch (err) {
    const message = describeError(err);
    emit(a.run_id, a.agent_id, "agent_ended", { outcome: "lost", endedAt: Date.now(), error: message });
    console.log(`[alineod]   lost ${a.agent_id}: ${message}`);
  }
}

async function retryProvision(a: AgentRow): Promise<void> {
  const spec = JSON.parse(a.spec_json);

  if (!a.parent_agent_id) {
    console.log(`[alineod]   retrying provision for root ${a.agent_id} (was still inside Alineo.load())...`);
    const body: CreateRunBody = {
      spec,
      prompt: a.prompt ?? undefined,
      budget: { spawnDepth: a.spawn_budget ?? undefined, maxAgents: a.max_agents_budget ?? undefined },
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
    console.log(`[alineod]   lost ${a.agent_id}: parent ${a.parent_agent_id} unavailable`);
    return;
  }

  console.log(`[alineod]   retrying provision for ${a.agent_id} (parent ${a.parent_agent_id} is live)...`);
  const body: SpawnAgentBody = {
    spec,
    parentAgentId: a.parent_agent_id,
    waitFor: a.wait_for ? (JSON.parse(a.wait_for) as string[]) : undefined,
    prompt: a.prompt ?? undefined,
  };
  await provisionChild(
    a.run_id,
    a.agent_id,
    a.parent_agent_id,
    a.spawn_budget ?? undefined,
    a.max_agents_budget ?? undefined,
    body,
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

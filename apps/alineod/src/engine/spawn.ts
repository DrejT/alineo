/**
 * `POST /runs/:runId/agents` — spawn a child under a parent agent.
 *
 * Async by design (Track A hardening, 2026-09-11): everything that's pure/synchronous (parent
 * validation, budget accounting, depth/spawnIndex, the `agent_spawned` row) happens before any
 * `await`, in the same tick as the request — so it can't race a concurrent spawn on the same
 * parent, and the child is visible in the projection immediately. The slow part — an optional
 * `waitFor` hold, then the actual `parent.spawn()` fork — runs in the background; the route
 * returns 202 with the child's `agentId` and lets the caller poll for the real state.
 *
 * Budget enforcement is the SDK's: `Alineo.prototype.spawn()` throws when `spawnDepth` /
 * `maxAgents` are exhausted (single source of truth — the counters are force-computed and
 * tamper-resistant). alineod catches that throw and turns it into `budget_denied`.
 *
 * The synchronous prefix above lets two children of the same parent be accepted in the same
 * tick — but the fork itself (`parent.spawn()`) is queued per parent (`fork-lock.ts`), never
 * run concurrently against one live sandbox: see opensandbox-group/OpenSandbox#1831.
 */
import type { Alineo } from "alineo";
import type { SpawnAgentBody } from "../schema";
import { newAgentId } from "../ids";
import { get, register } from "./registry";
import { withParentForkLock } from "./fork-lock";
import { emit } from "./emit";
import { driveTurn, setState } from "./stream";
import { registerNotify, withInbox } from "./notify";
import { isNotRunningError, waitUntilNotPaused } from "./hold";
import { errorMessage, sleep } from "../util";
import {
  normalizeWait,
  validateWait,
  waitForRegime,
  type NormalizedWait,
  type WaitOutcome,
} from "./waitfor";
import { writeSpecFile } from "./specfile";
import { readResult } from "./results";
import { getAgentRow, childCount, getHandle, hasPausedAncestor } from "../state/projection";
import { pauseAgent } from "./pause";
import { findIdempotent, recordIdempotent } from "../state/db";
import { HttpError } from "./errors";

export interface SpawnResult {
  agentId: string;
  state: string;
}

export function spawnAgent(runId: string, body: SpawnAgentBody): SpawnResult {
  const parentRow = getAgentRow(body.parentAgentId);
  if (!parentRow || parentRow.run_id !== runId) {
    throw new HttpError(404, `no agent ${body.parentAgentId} in run ${runId}`);
  }
  if (!get(body.parentAgentId)) {
    throw new HttpError(409, `agent ${body.parentAgentId} is not live (cannot spawn from it)`);
  }
  const wait = normalizeWait(body.waitFor);
  if (wait) {
    const problem = validateWait(wait);
    if (problem) throw new HttpError(400, problem);
    for (const depId of wait.agents) {
      const depRow = getAgentRow(depId);
      if (!depRow || depRow.run_id !== runId) {
        throw new HttpError(400, `waitFor references unknown agent ${depId}`);
      }
    }
  }

  for (const id of body.notifyOn ?? []) {
    const row = getAgentRow(id);
    if (!row || row.run_id !== runId)
      throw new HttpError(400, `notifyOn references unknown agent ${id}`);
  }

  // D-f: a client-supplied idempotency key lets a retried POST (e.g. after the response was
  // lost) return the original spawn instead of creating a second child.
  if (body.idempotencyKey) {
    const existing = findIdempotent(runId, body.idempotencyKey);
    if (existing) {
      const row = getAgentRow(existing);
      return { agentId: existing, state: row?.state ?? "provisioning" };
    }
  }

  const hasWaitFor = wait !== null;
  const childId = newAgentId();
  const specName = (body.spec.name as string | undefined) ?? "agent";

  // alineod-owned budget accounting (see db.ts). The value passed to parent.spawn() is "the
  // parent's remaining budget"; the SDK writes `value - 1` into the child's env and refuses at
  // <= 0.
  const spawnBudget = body.budget?.spawnDepth ?? parentRow.spawn_budget ?? undefined;
  const maxAgentsBudget = body.budget?.maxAgents ?? parentRow.max_agents_budget ?? undefined;

  // Synchronous prefix ends here — depth/spawnIndex/budgets are all read-then-written in this
  // one tick, so two concurrent spawns under the same parent can't compute the same spawnIndex.
  emit(runId, childId, "agent_spawned", {
    parentAgentId: body.parentAgentId,
    runId,
    specName,
    specJson: JSON.stringify(body.spec),
    depth: parentRow.depth + 1,
    spawnIndex: childCount(body.parentAgentId),
    sandboxId: null,
    spawnBudget: spawnBudget !== undefined ? spawnBudget - 1 : null,
    maxAgentsBudget: maxAgentsBudget !== undefined ? maxAgentsBudget - 1 : null,
    // Persisted so rehydrate() can retry this spawn if alineod crashes before it forks —
    // otherwise a still-pending waitFor hold only ever lived in this process's memory.
    waitFor: wait,
    prompt: body.prompt ?? null,
  });
  if (hasWaitFor) {
    emit(runId, childId, "agent_state_changed", {
      from: "provisioning",
      to: "spawning",
      reason: "waitFor",
    });
  }
  if (body.idempotencyKey) recordIdempotent(runId, body.idempotencyKey, childId);
  if (body.notifyOn && body.notifyOn.length > 0) registerNotify(runId, childId, body.notifyOn);

  void provisionChild(runId, childId, body.parentAgentId, spawnBudget, maxAgentsBudget, body, wait);

  return { agentId: childId, state: hasWaitFor ? "spawning" : "provisioning" };
}

/**
 * The slow half of a spawn: optional `waitFor` hold, then the actual `parent.spawn()` fork.
 * Exported so `rehydrate()` can re-run it verbatim for an agent that was still stuck here
 * (no sandbox yet) when alineod crashed — see db.ts's `wait_for`/`prompt` columns.
 */
export async function provisionChild(
  runId: string,
  childId: string,
  parentAgentId: string,
  spawnBudget: number | undefined,
  maxAgentsBudget: number | undefined,
  body: SpawnAgentBody,
  wait: NormalizedWait | null,
): Promise<void> {
  try {
    let waited: WaitOutcome | null = null;
    if (wait) {
      waited = await waitForRegime(runId, childId, wait);
      if (isCancelled(childId)) return; // stopped while it waited — leave its ended state alone
      emit(runId, childId, "wait_resolved", {
        mode: wait.mode,
        outcome: waited.outcome,
        selected: waited.selected,
        settled: waited.settled,
        pending: waited.pending,
      });
      if (waited.outcome === "depfail" || waited.outcome === "deadline") {
        const error =
          waited.outcome === "depfail"
            ? `dep-failed: ${waited.failed.join(", ") || "quorum unreachable"}`
            : `wait-deadline: still waiting on ${waited.pending.join(", ")}`;
        emit(runId, childId, "agent_ended", { outcome: "failed", endedAt: Date.now(), error });
        return;
      }
      emit(runId, childId, "agent_state_changed", {
        from: "spawning",
        to: "provisioning",
        reason: "deps-settled",
      });
    }

    const specPath = writeSpecFile(childId, body.spec);
    const child = await forkFromParent(runId, childId, parentAgentId, specPath, {
      spawnDepth: spawnBudget,
      maxAgents: maxAgentsBudget,
    });
    if (!child) return; // stopped while waiting on its paused parent

    if (isCancelled(childId)) {
      // Stopped while the fork was in flight — nothing else will ever close this sandbox.
      try {
        await child.close();
      } catch {
        /* ignore */
      }
      emit(runId, childId, "agent_released", { reason: "stopped-before-provisioned" });
      return;
    }

    register(childId, child);
    emit(runId, childId, "agent_provisioned", { sandboxId: child.sandboxId });

    if (wait && waited) await injectInputs(child, wait, waited);

    // A subtree pause reached this child before it existed (an ancestor above its direct parent is
    // paused — a paused direct parent would have held the fork above). Join the pause now, and
    // leave the first prompt for resumeAgent() to start. If the pause itself fails, run normally.
    if (hasPausedAncestor(childId)) {
      try {
        await pauseAgent(childId, { pausedBy: "cascade" });
        return;
      } catch {
        /* couldn't pause — fall through and start the prompt */
      }
    }
    if (body.prompt) void driveTurn(childId, withInbox(childId, body.prompt));
  } catch (err) {
    if (isCancelled(childId)) return; // already ended (stopped) — don't overwrite `aborted`
    const message = errorMessage(err);
    let outcome = "failed";
    if (/refused|budget|spawn-depth|max-agents/i.test(message)) {
      const dimension = /max-agents/i.test(message) ? "maxAgents" : "spawnDepth";
      emit(runId, parentAgentId, "budget_denied", { dimension, remaining: 0 });
      outcome = "budget-exceeded";
    }
    emit(runId, childId, "agent_ended", { outcome, endedAt: Date.now(), error: message });
  }
}

/** A spawn is cancelled once its agent has ended — i.e. it was stopped before it forked (B9). */
function isCancelled(childId: string): boolean {
  return getAgentRow(childId)?.ended_at != null;
}

/** Retries of a fork OpenSandbox refused as "not running" while the projection says it's running. */
const MAX_NOT_RUNNING_RETRIES = 10;

/**
 * `parent.spawn()`, waiting out any pause on the parent. OpenSandbox won't fork a paused sandbox
 * (hold.ts), so:
 *
 * - parent already paused → the child goes to `spawning` (`reason: "parent-paused"`) and waits
 *   for the resume, then back to `provisioning` (`"parent-resumed"`) once it forks;
 * - parent paused while the fork request is in flight → the refusal is retried the same way
 *   instead of failing the child;
 * - parent stopped while the child waits → "no longer live", same as today.
 *
 * Forks stay serialized per parent — see fork-lock.ts (opensandbox-group/OpenSandbox#1831): two
 * children of this same parent forking at once can each silently come back missing files.
 */
async function forkFromParent(
  runId: string,
  childId: string,
  parentAgentId: string,
  specPath: string,
  opts: { spawnDepth: number | undefined; maxAgents: number | undefined },
): Promise<Alineo | null> {
  let held = false;
  for (let retries = 0; ;) {
    if (isCancelled(childId)) return null;
    if (getAgentRow(parentAgentId)?.state === "paused") {
      held = true;
      setState(childId, "spawning", "parent-paused");
      await waitUntilNotPaused(runId, parentAgentId);
    }
    if (isCancelled(childId)) return null;

    const parent = get(parentAgentId);
    if (!parent) throw new Error(`parent ${parentAgentId} is no longer live`);

    try {
      const child = await withParentForkLock(parentAgentId, () => parent.spawn(specPath, opts));
      if (held) setState(childId, "provisioning", "parent-resumed");
      return child;
    } catch (err) {
      if (!isNotRunningError(err)) throw err;
      // Paused in the projection → loop back into the hold. Otherwise the sandbox isn't running
      // for some reason alineod doesn't know about: retry a few times, then fail the child.
      if (getAgentRow(parentAgentId)?.state !== "paused") {
        if (++retries > MAX_NOT_RUNNING_RETRIES) throw err;
        await sleep(3000);
      }
    }
  }
}

/**
 * Write each resolved dependency's result into the child's sandbox as a file, plus an
 * `/inputs.json` manifest the child's harness can read (research/daemon.md §8).
 */
async function injectInputs(
  child: Alineo,
  wait: NormalizedWait,
  waited: WaitOutcome,
): Promise<void> {
  const manifest: Record<string, unknown> = {};
  for (const depId of waited.selected) {
    const handle = getHandle(depId);
    const text = readResult(depId) ?? "";
    const path = `/inputs/${depId}.txt`;
    try {
      await child.sandbox.writeFile(path, text);
      manifest[depId] = { path, outcome: handle?.outcome ?? null };
    } catch {
      // best-effort
    }
  }
  // Anything beyond a plain, fully-satisfied `settled` wait also says how the wait resolved, so the
  // child can tell a partial or a race result from a complete one.
  if (wait.mode !== "settled" || waited.outcome !== "satisfied") {
    manifest.__wait = { mode: wait.mode, outcome: waited.outcome, pending: waited.pending };
  }
  try {
    await child.sandbox.writeFile("/inputs.json", JSON.stringify(manifest, null, 2));
  } catch {
    /* ignore */
  }
}

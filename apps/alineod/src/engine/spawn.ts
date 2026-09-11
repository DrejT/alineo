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
 */
import type { Alineo } from "alineo";
import type { SpawnAgentBody } from "../schema";
import { newAgentId } from "../ids";
import { get, register } from "./registry";
import { emit } from "./emit";
import { driveTurn } from "./stream";
import { waitForHandles } from "./waitfor";
import { writeSpecFile } from "./specfile";
import { readResult } from "./results";
import { getAgentRow, childCount, getHandle } from "../state/projection";
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
  if (body.waitFor) {
    for (const depId of body.waitFor) {
      const depRow = getAgentRow(depId);
      if (!depRow || depRow.run_id !== runId) {
        throw new HttpError(400, `waitFor references unknown agent ${depId}`);
      }
    }
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

  const hasWaitFor = !!body.waitFor && body.waitFor.length > 0;
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
    waitFor: body.waitFor ?? null,
    prompt: body.prompt ?? null,
  });
  if (hasWaitFor) {
    emit(runId, childId, "agent_state_changed", { from: "provisioning", to: "spawning", reason: "waitFor" });
  }
  if (body.idempotencyKey) recordIdempotent(runId, body.idempotencyKey, childId);

  void provisionChild(runId, childId, body.parentAgentId, spawnBudget, maxAgentsBudget, body);

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
): Promise<void> {
  try {
    if (body.waitFor && body.waitFor.length > 0) {
      await waitForHandles(runId, body.waitFor);
      emit(runId, childId, "agent_state_changed", { from: "spawning", to: "provisioning", reason: "deps-settled" });
    }

    const parent = get(parentAgentId);
    if (!parent) throw new Error(`parent ${parentAgentId} is no longer live`);

    const specPath = writeSpecFile(childId, body.spec);
    const child = await parent.spawn(specPath, { spawnDepth: spawnBudget, maxAgents: maxAgentsBudget });

    register(childId, child);
    emit(runId, childId, "agent_provisioned", { sandboxId: child.sandboxId });

    if (body.waitFor && body.waitFor.length > 0) await injectInputs(child, body.waitFor);
    if (body.prompt) void driveTurn(childId, body.prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let outcome = "failed";
    if (/refused|budget|spawn-depth|max-agents/i.test(message)) {
      const dimension = /max-agents/i.test(message) ? "maxAgents" : "spawnDepth";
      emit(runId, parentAgentId, "budget_denied", { dimension, remaining: 0 });
      outcome = "budget-exceeded";
    }
    emit(runId, childId, "agent_ended", { outcome, endedAt: Date.now(), error: message });
  }
}

/**
 * Write each resolved dependency's result into the child's sandbox as a file, plus an
 * `/inputs.json` manifest the child's harness can read (research/daemon.md §8).
 */
async function injectInputs(child: Alineo, waitFor: string[]): Promise<void> {
  const manifest: Record<string, { path: string; outcome: string | null }> = {};
  for (const depId of waitFor) {
    const handle = getHandle(depId);
    const text = readResult(depId) ?? "";
    const path = `/inputs/${depId}.txt`;
    try {
      await child.sandbox.writeFile(path, text);
      manifest[depId] = { path, outcome: handle?.outcome ?? null };
    } catch {
      // best-effort in the prototype
    }
  }
  try {
    await child.sandbox.writeFile("/inputs.json", JSON.stringify(manifest, null, 2));
  } catch {
    /* ignore */
  }
}

/**
 * `POST /runs/:runId/agents` — spawn a child under a parent agent.
 *
 * Path: (optionally hold for `waitFor` deps) → `parent.spawn(specPath)` → register → emit
 * `agent_spawned` → write the resolved dependency results into the child's sandbox → optionally
 * drive a turn.
 *
 * Budget enforcement is the SDK's: `Alineo.prototype.spawn()` throws when `spawnDepth` /
 * `maxAgents` are exhausted (single source of truth — the counters are force-computed and
 * tamper-resistant). alineod catches that throw and turns it into `budget_denied` + 409.
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
import { HttpError } from "./errors";

export interface SpawnResult {
  agentId: string;
}

export async function spawnAgent(runId: string, body: SpawnAgentBody): Promise<SpawnResult> {
  const parentRow = getAgentRow(body.parentAgentId);
  if (!parentRow || parentRow.run_id !== runId) {
    throw new HttpError(404, `no agent ${body.parentAgentId} in run ${runId}`);
  }
  const parent = get(body.parentAgentId);
  if (!parent) {
    throw new HttpError(409, `agent ${body.parentAgentId} is not live (cannot spawn from it)`);
  }

  if (body.waitFor && body.waitFor.length > 0) {
    for (const depId of body.waitFor) {
      const depRow = getAgentRow(depId);
      if (!depRow || depRow.run_id !== runId) {
        throw new HttpError(400, `waitFor references unknown agent ${depId}`);
      }
    }
    await waitForHandles(runId, body.waitFor);
  }

  const childId = newAgentId();
  const specPath = writeSpecFile(childId, body.spec);

  let child: Alineo;
  try {
    child = await parent.spawn(specPath, {
      spawnDepth: body.budget?.spawnDepth,
      maxAgents: body.budget?.maxAgents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/refused|budget|spawn-depth|max-agents/i.test(message)) {
      const dimension = /max-agents/i.test(message) ? "maxAgents" : "spawnDepth";
      emit(runId, body.parentAgentId, "budget_denied", { dimension, remaining: 0 });
      throw new HttpError(409, `spawn denied: ${message}`);
    }
    throw new HttpError(500, `spawn failed: ${message}`);
  }

  register(childId, child);

  emit(runId, childId, "agent_spawned", {
    parentAgentId: body.parentAgentId,
    runId,
    specName: child.name,
    specJson: JSON.stringify(body.spec),
    depth: parentRow.depth + 1,
    spawnIndex: childCount(body.parentAgentId),
    sandboxId: child.sandboxId,
  });

  if (body.waitFor && body.waitFor.length > 0) {
    await injectInputs(child, body.waitFor);
  }

  if (body.prompt) void driveTurn(childId, body.prompt);

  return { agentId: childId };
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

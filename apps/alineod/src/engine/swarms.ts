/**
 * Realizes a confirmed swarm plan (`swarm-planner.ts`) through the *existing* `createRun`/
 * `spawnAgent` engine functions — this file is pure orchestration over endpoints that already
 * exist, not a new provisioning path. Nodes are spawned one at a time, each waiting for its
 * plan-parent to be live first (spawnAgent requires a live parent synchronously; there's no
 * queue-and-retry for that in the existing engine, so this orchestrator provides the wait).
 */
import { createRun } from "./runs";
import { spawnAgent } from "./spawn";
import { get } from "./registry";
import { getAgentRow } from "../state/projection";
import { sleep } from "../util";
import { HttpError } from "./errors";
import { validatePlan, defaultResources, type SwarmPlan, type RawPlan } from "./swarm-planner";
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("alineod");

const MODEL = process.env.ALINEOD_SWARM_AGENT_MODEL ?? "gemini-flash-latest";
const LIVE_POLL_MS = 1_000;
const LIVE_TIMEOUT_MS = Number(process.env.ALINEOD_SWARM_PARENT_TIMEOUT_MS ?? 5 * 60_000);

export interface RealizeResult {
  runId: string;
  agentIds: Record<string, string>;
}

function specFor(nodeId: string, role: string) {
  return {
    name: nodeId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 63),
    title: role,
    harness: "pi" as const,
    model: MODEL,
    env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
    resources: defaultResources(),
  };
}

/** `POST /swarms` — re-validates (never trusts a client-held plan) and realizes it. Returns as
 *  soon as the root run exists; the rest of the tree spawns in the background, visible on
 *  `GET /runs/:runId/events` the same way an individually-spawned child always has been. */
export function createSwarm(raw: RawPlan): RealizeResult {
  const plan = validatePlan(raw);
  if (plan.ambiguous || plan.violatesLimits.length > 0) {
    throw new HttpError(
      422,
      `plan is not realizable: ${plan.ambiguous ? "ambiguous (not exactly one root); " : ""}${plan.violatesLimits.join("; ")}`,
    );
  }

  const root = plan.nodes.find((n) => n.parentId === null)!;
  const { runId, rootAgentId } = createRun({
    spec: specFor(root.id, root.role),
    prompt: root.task,
    budget: { spawnDepth: plan.spawnDepth, maxAgents: plan.maxAgents },
  });

  const agentIds: Record<string, string> = { [root.id]: rootAgentId };
  void realizeRest(runId, plan, agentIds);

  return { runId, agentIds };
}

async function realizeRest(
  runId: string,
  plan: SwarmPlan,
  agentIds: Record<string, string>,
): Promise<void> {
  const remaining = plan.nodes.filter((n) => n.parentId !== null);
  const done = new Set(Object.keys(agentIds));

  // Repeatedly spawn whatever's now spawnable (parent done, every waitFor dep already spawned),
  // in plan order within each pass — small trees (≤ maxAgentsCeiling), simplicity over
  // throughput. A pass that spawns nothing while work remains means a dependency can never be
  // satisfied (should be impossible after validatePlan's cycle check) — bail rather than spin.
  while (done.size < plan.nodes.length) {
    const next = remaining.find(
      (n) => !done.has(n.id) && done.has(n.parentId!) && (n.waitFor ?? []).every((d) => done.has(d)),
    );
    if (!next) {
      log.error("swarm plan stalled: unresolvable dependency", { runId, remaining: remaining.length });
      return;
    }

    const parentAgentId = agentIds[next.parentId!]!;
    const live = await waitUntilLive(parentAgentId);
    if (!live) return; // parent never came up — the dashboard sees it failed on its own agent row

    const { agentId } = spawnAgent(runId, {
      parentAgentId,
      spec: specFor(next.id, next.role),
      prompt: next.task,
      waitFor: (next.waitFor ?? []).map((d) => agentIds[d]!),
    });
    agentIds[next.id] = agentId;
    done.add(next.id);
  }
}

async function waitUntilLive(agentId: string): Promise<boolean> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (get(agentId)) return true;
    const row = getAgentRow(agentId);
    if (row?.ended_at) return false; // failed/aborted before ever coming up
    await sleep(LIVE_POLL_MS);
  }
  return false;
}

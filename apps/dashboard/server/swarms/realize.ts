/**
 * Realizes a confirmed swarm plan (`planner.ts`) through alineod's public HTTP API: `POST /runs`
 * for the root, then `POST /runs/:runId/agents` for each child. This is orchestration over
 * endpoints that already exist, not a new provisioning path. Nodes spawn one at a time, each
 * once its plan-parent is live. alineod answers 409 for a parent that is not live yet, so this
 * file retries that call until the parent comes up.
 */
import type { AgentView, CreateRunBody, SpawnAgentBody } from "@alineo-labs/schema/alineod";
import { getLogger } from "@alineo-labs/logger";
import { alineodJson } from "../alineod";
import { config } from "../config";
import { HttpError, sleep } from "../http";
import { validatePlan, defaultResources, type SwarmPlan, type RawPlan } from "./planner";

const log = getLogger("dashboard");

export interface RealizeResult {
  runId: string;
  agentIds: Record<string, string>;
}

function specFor(nodeId: string, role: string): CreateRunBody["spec"] {
  return {
    name: nodeId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 63),
    title: role,
    harness: "pi",
    model: config.swarm.agentModel,
    env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
    resources: defaultResources(),
  } as CreateRunBody["spec"];
}

/** `POST /swarms` — re-validates (never trusts a client-held plan) and realizes it. Returns as
 *  soon as the root run exists. The rest of the tree spawns in the background and shows up on
 *  `GET /runs/:runId/events` like any individually spawned child. */
export async function createSwarm(raw: RawPlan): Promise<RealizeResult> {
  const plan = validatePlan(raw);
  if (plan.ambiguous || plan.violatesLimits.length > 0) {
    throw new HttpError(
      422,
      `plan is not realizable: ${plan.ambiguous ? "ambiguous (not exactly one root); " : ""}${plan.violatesLimits.join("; ")}`,
    );
  }

  const root = plan.nodes.find((n) => n.parentId === null)!;
  const body: CreateRunBody = {
    spec: specFor(root.id, root.role),
    prompt: root.task,
    budget: { spawnDepth: plan.spawnDepth, maxAgents: plan.maxAgents },
  };
  const { runId, rootAgentId } = await alineodJson<{ runId: string; rootAgentId: string }>(
    "POST",
    "/runs",
    body,
  );

  const agentIds: Record<string, string> = { [root.id]: rootAgentId };
  void realizeRest(runId, plan, agentIds).catch((err) => {
    log.error("swarm realization failed", { runId, err });
  });

  return { runId, agentIds };
}

async function realizeRest(
  runId: string,
  plan: SwarmPlan,
  agentIds: Record<string, string>,
): Promise<void> {
  const remaining = plan.nodes.filter((n) => n.parentId !== null);
  const done = new Set(Object.keys(agentIds));

  // Repeatedly spawn whatever is now spawnable (parent done, every waitFor dep already spawned),
  // in plan order. Trees are small (≤ the agent ceiling), so simplicity beats throughput. A pass
  // that finds nothing spawnable while work remains means a dependency can never be met (the
  // plan check rules this out) — bail rather than spin.
  while (done.size < plan.nodes.length) {
    const next = remaining.find(
      (n) =>
        !done.has(n.id) && done.has(n.parentId!) && (n.waitFor ?? []).every((d) => done.has(d)),
    );
    if (!next) {
      log.error("swarm plan stalled: unresolvable dependency", {
        runId,
        remaining: remaining.length,
      });
      return;
    }

    const body: SpawnAgentBody = {
      parentAgentId: agentIds[next.parentId!]!,
      spec: specFor(next.id, next.role),
      prompt: next.task,
      waitFor: (next.waitFor ?? []).map((d) => agentIds[d]!),
    };
    const agentId = await spawnWhenParentLive(runId, body);
    if (!agentId) return; // parent never came up — the dashboard sees its failure on its own agent row
    agentIds[next.id] = agentId;
    done.add(next.id);
  }
}

/** Spawns a child, retrying while alineod reports the parent is not live yet (409). Gives up when
 *  the parent fails or the timeout passes. Returns the new agent's id, or null on give-up. */
async function spawnWhenParentLive(runId: string, body: SpawnAgentBody): Promise<string | null> {
  const deadline = Date.now() + config.swarm.parentTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const { agentId } = await alineodJson<{ agentId: string }>(
        "POST",
        `/runs/${runId}/agents`,
        body,
      );
      return agentId;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 409) throw err;
    }
    const parent = await alineodJson<AgentView>("GET", `/agents/${body.parentAgentId}`);
    if (parent.state === "failed") return null;
    await sleep(config.swarm.retryMs);
  }
  return null;
}

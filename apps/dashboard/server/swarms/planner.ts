/**
 * Natural-language swarm planning: turns a prompt into a structured, editable plan.
 * Planning never touches OpenSandbox or alineod. Realizing a confirmed plan (`realize.ts`) is what
 * actually spawns anything, through alineod's `POST /runs` and `POST /runs/:id/agents`.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { googleProvider } from "@alineo-labs/model-providers";
import { loadProjectConfig } from "@alineo-labs/config-shared";
import { HttpError } from "../http";
import { config } from "../config";

const PlanNode = z.object({
  id: z.string().min(1).describe("short stable identifier used to express parent/child edges"),
  role: z.string().min(1).describe("one short phrase, e.g. 'worker', 'reviewer', 'coordinator'"),
  task: z.string().min(1).describe("the concrete instruction this agent should carry out"),
  parentId: z.string().nullable().describe("id of the spawning parent, or null for the root"),
  waitFor: z
    .array(z.string())
    .optional()
    .describe("ids of sibling nodes this one should wait on before starting"),
});

const PlanSchema = z.object({
  nodes: z.array(PlanNode).min(1),
  spawnDepth: z.number().int().positive().describe("max nesting depth any node may spawn below it"),
  maxAgents: z.number().int().positive().describe("total agent budget for the whole swarm"),
});

type PlanNode = z.infer<typeof PlanNode>;
export type RawPlan = z.infer<typeof PlanSchema>;

export interface SwarmPlan extends RawPlan {
  ambiguous: boolean;
  violatesLimits: string[];
}

const SYSTEM_PROMPT = `You turn a plain-language request into a plan for a swarm of AI coding \
agents. Each node is one agent: give it a short id, a one-phrase role, and a concrete task \
description. Exactly one node must have parentId: null (the root/coordinator) — every other \
node's parentId must name an existing node's id, and a node may only depend on (waitFor) \
sibling nodes under the same parent. Keep the tree as shallow as the request allows. Set \
spawnDepth to the deepest nesting the plan actually needs and maxAgents to the exact node \
count — never pad either budget. If the request is too vague to plan concretely (no clear task, \
or an unbounded/"as many as needed" count), still produce your best single-node guess, since \
ambiguity is flagged separately by the caller, not by you.`;

/** Server-side limits a plan is checked against, independent of whatever the model proposed —
 *  mirrors the enforcement `packages/agent/src/agent/validation.ts` applies at spawn time, so a
 *  plan that would later be refused by the SDK is caught here instead, with a legible reason. */
interface PlanLimits {
  maxSpawnDepth: number;
  maxAgentsCeiling: number;
}

const DEFAULT_LIMITS: PlanLimits = {
  maxSpawnDepth: config.swarm.maxDepth,
  maxAgentsCeiling: config.swarm.maxAgents,
};

export async function planSwarm(prompt: string, limits = DEFAULT_LIMITS): Promise<SwarmPlan> {
  if (!prompt.trim()) throw new HttpError(400, "prompt is required");

  const model = googleProvider.languageModel(config.swarm.plannerModel);
  let raw: RawPlan;
  try {
    const result = await generateObject({
      model,
      schema: PlanSchema,
      system: SYSTEM_PROMPT,
      prompt,
    });
    raw = result.object;
  } catch (err) {
    throw new HttpError(
      502,
      `swarm planner model call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return validatePlan(raw, limits);
}

/** Re-validates a plan — called both right after planning and again on `POST /swarms`, since a
 *  client-held plan (possibly hand-edited in the dashboard's preview) is never trusted blindly. */
export function validatePlan(raw: RawPlan, limits = DEFAULT_LIMITS): SwarmPlan {
  const problems: string[] = [];
  const byId = new Map(raw.nodes.map((n) => [n.id, n]));

  if (byId.size !== raw.nodes.length) problems.push("duplicate node ids");

  const roots = raw.nodes.filter((n) => n.parentId === null);
  if (roots.length !== 1) problems.push(`exactly one root node is required, found ${roots.length}`);

  for (const node of raw.nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      problems.push(`node "${node.id}" has unknown parentId "${node.parentId}"`);
    }
    for (const dep of node.waitFor ?? []) {
      const depNode = byId.get(dep);
      if (!depNode) problems.push(`node "${node.id}" waits on unknown node "${dep}"`);
      else if (depNode.parentId !== node.parentId) {
        problems.push(`node "${node.id}" can only wait on siblings (same parentId)`);
      }
    }
  }

  // Depth: walk from each node up to its root, counting edges. A cycle would loop forever, so
  // cap the walk at the node count — anything still unresolved past that is a cycle.
  let maxDepth = 0;
  for (const node of raw.nodes) {
    let depth = 0;
    let cur: PlanNode | undefined = node;
    const seen = new Set<string>();
    while (cur?.parentId !== null && cur !== undefined) {
      if (seen.has(cur.id)) {
        problems.push(`cycle detected involving node "${cur.id}"`);
        break;
      }
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
      depth++;
      if (depth > raw.nodes.length) break;
    }
    maxDepth = Math.max(maxDepth, depth);
  }

  if (raw.spawnDepth > limits.maxSpawnDepth) {
    problems.push(
      `spawnDepth ${raw.spawnDepth} exceeds the project ceiling of ${limits.maxSpawnDepth}`,
    );
  }
  if (maxDepth > raw.spawnDepth) {
    problems.push(`plan needs depth ${maxDepth} but spawnDepth is only ${raw.spawnDepth}`);
  }
  if (raw.nodes.length > limits.maxAgentsCeiling) {
    problems.push(
      `${raw.nodes.length} nodes exceeds the project ceiling of ${limits.maxAgentsCeiling}`,
    );
  }
  if (raw.nodes.length > raw.maxAgents) {
    problems.push(`${raw.nodes.length} nodes exceeds the plan's own maxAgents (${raw.maxAgents})`);
  }

  return { ...raw, ambiguous: roots.length !== 1, violatesLimits: problems };
}

/** Project default resources (`alineo.config.json`'s `defaults.resources`), used for any plan
 *  node that doesn't specify its own. */
export function defaultResources(): { cpu: string; memory: string } {
  const config = loadProjectConfig({ cwd: process.cwd() });
  return config.defaults.resources;
}

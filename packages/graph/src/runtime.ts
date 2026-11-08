import { idOf, keys, type KnowledgeGraph } from "./model";

/** Terminal states that mean an agent did not finish its work. */
const FAILED_STATES = new Set(["failed", "aborted", "lost"]);
const TERMINAL_STATES = new Set(["done", "failed", "aborted", "lost"]);

/** Children of an agent, following only `spawned` edges. */
function childrenOf(graph: KnowledgeGraph, agentKey: string): string[] {
  const out: string[] = [];
  graph.forEachOutEdge(agentKey, (_edge, attrs, _source, target) => {
    if (attrs.kind === "spawned") out.push(target);
  });
  return out;
}

function parentOf(graph: KnowledgeGraph, agentKey: string): string | undefined {
  if (!graph.hasNode(agentKey)) return undefined;
  let parent: string | undefined;
  graph.forEachInEdge(agentKey, (_edge, attrs, source) => {
    if (attrs.kind === "spawned") parent = source;
  });
  return parent;
}

export interface Descendant {
  agentId: string;
  depth: number;
  state: string | undefined;
}

/**
 * Every agent that `agentId` spawned, directly or not, nearest first. Answers "what does this
 * agent's subtree look like", the question `subtree.ts` and `supervision.ts` answer from tables.
 */
export function subtree(graph: KnowledgeGraph, agentId: string): Descendant[] {
  const root = keys.agent(agentId);
  if (!graph.hasNode(root)) return [];
  const found: Descendant[] = [];
  const seen = new Set([root]);
  let frontier = [root];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const key of frontier) {
      for (const child of childrenOf(graph, key)) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
        found.push({ agentId: idOf(child), depth, state: graph.getNodeAttribute(child, "state") });
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * The agents above `agentId`, nearest parent first, ending at the root. "Which run of the swarm
 * made this wrong result" starts here.
 */
export function ancestry(graph: KnowledgeGraph, agentId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = parentOf(graph, keys.agent(agentId));
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(idOf(current));
    current = parentOf(graph, current);
  }
  return chain;
}

/** Descendants of `agentId` that did not finish: what a failing subtree is made of. */
export function failedSubtree(graph: KnowledgeGraph, agentId: string): Descendant[] {
  return subtree(graph, agentId).filter((d) => d.state !== undefined && FAILED_STATES.has(d.state));
}

export interface LineageStep {
  sandboxId: string;
  /** How this sandbox relates to the previous one in the chain. */
  via: "forked_from" | "restored_from";
  checkpointTurn?: number | null;
}

/**
 * Where a sandbox came from: the forks and restores behind it, newest ancestor first. A restore
 * says the original container was lost; the chain shows how many times that has happened.
 */
export function sandboxLineage(graph: KnowledgeGraph, sandboxId: string): LineageStep[] {
  const steps: LineageStep[] = [];
  const seen = new Set<string>();
  let current = keys.sandbox(sandboxId);
  while (graph.hasNode(current) && !seen.has(current)) {
    seen.add(current);
    let next: { key: string; step: LineageStep } | undefined;
    graph.forEachOutEdge(current, (_edge, attrs, _source, target) => {
      if (attrs.kind !== "forked_from" && attrs.kind !== "restored_from") return;
      next = {
        key: target,
        step: {
          sandboxId: idOf(target),
          via: attrs.kind,
          ...(attrs.checkpointTurn !== undefined ? { checkpointTurn: attrs.checkpointTurn } : {}),
        },
      };
    });
    if (!next) break;
    steps.push(next.step);
    current = next.key;
  }
  return steps;
}

export interface OrphanSandbox {
  sandboxId: string;
  reason: "unknown" | "closed" | "owner-finished";
}

/**
 * Sandboxes that are live in the control plane but that the graph says should not be: never
 * seen, already closed, or owned only by agents that have finished. `liveSandboxIds` comes from
 * the provider; the graph never calls it.
 */
export function orphanSandboxes(
  graph: KnowledgeGraph,
  liveSandboxIds: Iterable<string>,
): OrphanSandbox[] {
  const orphans: OrphanSandbox[] = [];
  for (const sandboxId of liveSandboxIds) {
    const key = keys.sandbox(sandboxId);
    if (!graph.hasNode(key)) {
      orphans.push({ sandboxId, reason: "unknown" });
      continue;
    }
    if (graph.getNodeAttribute(key, "closedAt") !== undefined) {
      orphans.push({ sandboxId, reason: "closed" });
      continue;
    }
    const owners: string[] = [];
    graph.forEachInEdge(key, (_edge, attrs, source) => {
      if (attrs.kind === "ran_in") owners.push(source);
    });
    const allFinished =
      owners.length > 0 &&
      owners.every((owner) => {
        const state = graph.getNodeAttribute(owner, "state");
        return state !== undefined && TERMINAL_STATES.has(state);
      });
    if (allFinished) orphans.push({ sandboxId, reason: "owner-finished" });
  }
  return orphans;
}

/** Agents in a run, in the order the graph first saw them. */
export function agentsOfRun(graph: KnowledgeGraph, runId: string): string[] {
  const run = keys.run(runId);
  if (!graph.hasNode(run)) return [];
  const agents: string[] = [];
  graph.forEachOutEdge(run, (_edge, attrs, _source, target) => {
    if (attrs.kind === "contains") agents.push(idOf(target));
  });
  return agents;
}

import { unweighted } from "graphology-shortest-path";
import { idOf, keys, type EdgeKind, type KnowledgeGraph } from "./model";

/**
 * Agents a subject stands for. A binding made on an agent is that agent's. One made on a
 * sandbox, or on the scope a sandbox's events arrive under, belongs to whichever agents ran in it.
 */
function agentsOf(graph: KnowledgeGraph, subject: string): string[] {
  const kind = graph.getNodeAttribute(subject, "kind");
  if (kind === "agent") return [subject];
  const sandboxes: string[] = [];
  if (kind === "sandbox") sandboxes.push(subject);
  if (kind === "scope") {
    graph.forEachInEdge(subject, (_edge, attrs, source) => {
      if (attrs.kind === "in_scope") sandboxes.push(source);
    });
  }
  const agents: string[] = [];
  for (const sandbox of sandboxes) {
    graph.forEachInEdge(sandbox, (_edge, attrs, source) => {
      if (attrs.kind === "ran_in") agents.push(source);
    });
  }
  return agents;
}

function descendantsOf(graph: KnowledgeGraph, agents: Iterable<string>): string[] {
  const seen = new Set<string>(agents);
  const added: string[] = [];
  const queue = [...seen];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    if (current === undefined) continue;
    graph.forEachOutEdge(current, (_edge, attrs, _source, target) => {
      if (attrs.kind !== "spawned" || seen.has(target)) return;
      seen.add(target);
      added.push(target);
      queue.push(target);
    });
  }
  return added;
}

export interface CredentialHolder {
  agentId: string;
  /** False once the binding was revoked. */
  active: boolean;
  /** The node the binding was made on (agent, sandbox or scope). */
  boundOn: string;
}

/**
 * Who has held a credential, including holders that no longer do. The binding's subject is
 * resolved to agents, so a credential bound on a sandbox is attributed to the agents that ran in it.
 */
export function credentialHolders(graph: KnowledgeGraph, name: string): CredentialHolder[] {
  const credential = keys.credential(name);
  if (!graph.hasNode(credential)) return [];
  const holders = new Map<string, CredentialHolder>();
  graph.forEachInEdge(credential, (_edge, attrs, subject) => {
    if (attrs.kind !== "holds") return;
    const active = attrs.endedAt === undefined;
    for (const agent of agentsOf(graph, subject)) {
      const id = idOf(agent);
      const existing = holders.get(id);
      // Holding it through any live binding makes the agent a live holder.
      if (!existing || (active && !existing.active)) {
        holders.set(id, { agentId: id, active, boundOn: subject });
      }
    }
  });
  return [...holders.values()];
}

export interface BlastRadius {
  holders: CredentialHolder[];
  /**
   * Agents spawned, directly or not, by a live holder. The graph records what each agent was
   * bound; it does not record whether a child inherited its parent's credential, so these are
   * agents that could have been handed it, not agents proved to have it.
   */
  potentiallyReachable: string[];
}

export function blastRadius(graph: KnowledgeGraph, name: string): BlastRadius {
  const holders = credentialHolders(graph, name);
  const live = holders.filter((h) => h.active).map((h) => keys.agent(h.agentId));
  const holderKeys = new Set(holders.map((h) => keys.agent(h.agentId)));
  const potentiallyReachable = descendantsOf(graph, live)
    .filter((key) => !holderKeys.has(key))
    .map(idOf);
  return { holders, potentiallyReachable };
}

/** Does egress rule `pattern` cover `host`? `*.example.com` covers subdomains, not the apex. */
export function targetMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*."))
    return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return false;
}

export interface EgressReach {
  agentId: string;
  rule: string;
}

function activeEgress(
  graph: KnowledgeGraph,
  kind: EdgeKind,
  subject: string,
  host: string,
): string[] {
  const rules: string[] = [];
  graph.forEachOutEdge(subject, (_edge, attrs, _source, target) => {
    if (attrs.kind !== kind || attrs.endedAt !== undefined) return;
    const pattern = idOf(target);
    if (targetMatches(pattern, host)) rules.push(pattern);
  });
  return rules;
}

/**
 * Agents with a standing egress allowance covering `host`. An exact deny on the same subject
 * beats a wildcard allow; a wildcard deny does not beat an exact allow. This is the policy as
 * recorded, not as the sidecar enforces it.
 */
export function egressReach(graph: KnowledgeGraph, host: string): EgressReach[] {
  const reach = new Map<string, EgressReach>();
  graph.forEachNode((subject, attrs) => {
    if (attrs.kind !== "agent" && attrs.kind !== "sandbox" && attrs.kind !== "scope") return;
    const allows = activeEgress(graph, "egress_allow", subject, host);
    if (allows.length === 0) return;
    const denies = activeEgress(graph, "egress_deny", subject, host);
    const rule = allows.find((a) => !denies.includes(a) && !(denies.includes(host) && a !== host));
    if (rule === undefined) return;
    for (const agent of agentsOf(graph, subject)) {
      const id = idOf(agent);
      if (!reach.has(id)) reach.set(id, { agentId: id, rule });
    }
  });
  return [...reach.values()];
}

export interface PendingPermission {
  requestId: string;
  by: string;
  what: string;
}

/** Permission requests nothing has answered yet. */
export function pendingPermissions(graph: KnowledgeGraph): PendingPermission[] {
  const pending: PendingPermission[] = [];
  graph.forEachNode((key, attrs) => {
    if (attrs.kind !== "permission" || attrs.decision !== undefined) return;
    graph.forEachInEdge(key, (_edge, edge, source) => {
      if (edge.kind === "requested") {
        pending.push({ requestId: idOf(key), by: idOf(source), what: attrs.label });
      }
    });
  });
  return pending;
}

export interface PathHop {
  node: string;
  /** The edge kind that led here from the previous node. Absent for the start. */
  via?: EdgeKind;
}

/**
 * The shortest chain of relationships from one node to another: agent → credential → host
 * answers "how can this agent reach that API". Null when nothing connects them.
 */
export function explainPath(graph: KnowledgeGraph, from: string, to: string): PathHop[] | null {
  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;
  const path = unweighted.bidirectional(graph, from, to);
  if (path === null) return null;
  return path.map((key, i): PathHop => {
    const previous = path[i - 1];
    if (previous === undefined) return { node: key };
    const edge = graph.edges(previous, key)[0];
    return edge === undefined
      ? { node: key }
      : { node: key, via: graph.getEdgeAttribute(edge, "kind") };
  });
}

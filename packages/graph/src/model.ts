import Graph from "graphology";

/**
 * The two layers of the knowledge graph share one node set, because the interesting security
 * questions cross them: "which agents could use this credential" starts in the governance layer
 * (a binding) and ends in the runtime layer (an agent, its sandbox, its children).
 */
export type NodeKind =
  | "run"
  | "agent"
  | "spec"
  | "sandbox"
  | "scope"
  | "checkpoint"
  | "result"
  | "credential"
  | "host"
  | "permission"
  | "budget";

export type EdgeKind =
  // runtime provenance
  | "contains" // run -> agent
  | "spawned" // parent agent -> child agent
  | "instance_of" // agent -> spec
  | "ran_in" // agent -> sandbox
  | "in_scope" // sandbox -> scope (the event stream a sandbox's own events arrive under)
  | "forked_from" // sandbox -> parent sandbox
  | "restored_from" // replacement sandbox -> the sandbox that was lost
  | "checkpointed" // sandbox | agent -> checkpoint
  | "produced" // agent -> result
  // security and governance
  | "holds" // agent | sandbox | scope -> credential
  | "scoped_to" // credential -> host
  | "egress_allow" // agent | scope -> host
  | "egress_deny"
  | "requested" // agent | scope -> permission
  | "denied"; // agent -> budget

export interface NodeAttributes {
  kind: NodeKind;
  label: string;
  /** Agent lifecycle state, as last folded from `agent.state_changed`. */
  state?: string;
  outcome?: string;
  error?: string;
  depth?: number;
  /** An agent's current sandbox id, kept so `agent.restored` can find the replacement. */
  sandboxId?: string;
  provider?: string;
  closedAt?: number;
  /** Permission request: the decision once `permission.resolved` arrives. */
  decision?: string;
  /** Result node: where the result lives. */
  resultRef?: string;
}

export interface EdgeAttributes {
  kind: EdgeKind;
  at?: number;
  /** Set when what the edge records was later undone: a revoked credential, a removed rule. */
  endedAt?: number;
  injection?: string;
  checkpointTurn?: number | null;
  turn?: number;
  /** `budget.denied` can recur; one edge carries the count. */
  count?: number;
}

export type KnowledgeGraph = Graph<NodeAttributes, EdgeAttributes>;

export function createKnowledgeGraph(): KnowledgeGraph {
  return new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: true });
}

export const keys = {
  run: (id: string) => `run:${id}`,
  agent: (id: string) => `agent:${id}`,
  spec: (name: string) => `spec:${name}`,
  sandbox: (id: string) => `sandbox:${id}`,
  scope: (id: string) => `scope:${id}`,
  checkpoint: (id: string) => `checkpoint:${id}`,
  result: (agentId: string) => `result:${agentId}`,
  credential: (name: string) => `credential:${name}`,
  host: (target: string) => `host:${target}`,
  permission: (requestId: string) => `permission:${requestId}`,
  budget: (dimension: string) => `budget:${dimension}`,
} as const;

/** The id part of a node key (`agent:a1` → `a1`). */
export function idOf(nodeKey: string): string {
  return nodeKey.slice(nodeKey.indexOf(":") + 1);
}

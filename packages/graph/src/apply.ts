import { AgentEvents, AlineodEvents, SandboxEvents } from "@alineo-labs/schema";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import {
  createKnowledgeGraph,
  keys,
  type EdgeAttributes,
  type EdgeKind,
  type KnowledgeGraph,
  type NodeAttributes,
  type NodeKind,
} from "./model";

function node(graph: KnowledgeGraph, kind: NodeKind, key: string, label: string): string {
  graph.mergeNode(key, { kind, label });
  return key;
}

/**
 * One edge per (kind, from, to). A repeat folds into the same edge, so replaying a ledger, or
 * applying the same envelope twice after a crash, leaves the graph unchanged.
 */
function link(
  graph: KnowledgeGraph,
  kind: EdgeKind,
  from: string,
  to: string,
  extra: Partial<EdgeAttributes> = {},
): string {
  const key = `${kind}|${from}|${to}`;
  graph.mergeEdgeWithKey(key, from, to, { kind, ...extra });
  return key;
}

/**
 * Who an event is about. An agent when the envelope names one, otherwise the scope its stream
 * arrived under: the SDK stamps sandbox-level events (credentials, egress) with the sandbox
 * session, which `sandbox.created` ties to a sandbox and `agent.provisioned` ties to an agent.
 */
function subjectOf(graph: KnowledgeGraph, env: LedgerEnvelope): string | undefined {
  if (env.agentId) return node(graph, "agent", keys.agent(env.agentId), env.agentId);
  if (env.runId) return node(graph, "scope", keys.scope(env.runId), env.runId);
  return undefined;
}

function isNetworkRule(value: unknown): value is { action: "allow" | "deny"; target: string } {
  if (typeof value !== "object" || value === null) return false;
  const action = Object.getOwnPropertyDescriptor(value, "action")?.value;
  const target = Object.getOwnPropertyDescriptor(value, "target")?.value;
  return (action === "allow" || action === "deny") && typeof target === "string";
}

function patchNode(graph: KnowledgeGraph, key: string, attrs: Partial<NodeAttributes>): void {
  if (graph.hasNode(key)) graph.mergeNodeAttributes(key, attrs);
}

function attachSandbox(
  graph: KnowledgeGraph,
  agent: string,
  sandboxId: string,
  provider: string | undefined,
  at: number,
): void {
  const sandbox = keys.sandbox(sandboxId);
  graph.mergeNode(sandbox, {
    kind: "sandbox",
    label: sandboxId,
    ...(provider !== undefined ? { provider } : {}),
  });
  link(graph, "ran_in", agent, sandbox, { at });
  graph.mergeNodeAttributes(agent, { sandboxId });
}

/**
 * Fold one envelope into the graph. Total: an event it does not know, or whose data does not
 * match its schema, is ignored. A sink runs on the write path of the operation being recorded
 * and must not be the reason it fails.
 */
export function apply(graph: KnowledgeGraph, env: LedgerEnvelope): void {
  switch (env.type) {
    case "run.started": {
      const r = AlineodEvents.RunStarted.schema.safeParse(env.data);
      if (r.success) node(graph, "run", keys.run(r.data.runId), r.data.runId);
      return;
    }
    case "agent.spawned": {
      const r = AlineodEvents.AgentSpawned.schema.safeParse(env.data);
      if (!r.success || r.data.agentId === null) return;
      const d = r.data;
      const agentId = d.agentId;
      if (agentId === null) return;
      const agent = keys.agent(agentId);
      graph.mergeNode(agent, {
        kind: "agent",
        label: agentId,
        depth: d.depth,
        state: "provisioning",
      });
      link(graph, "contains", node(graph, "run", keys.run(d.runId), d.runId), agent, {
        at: env.ts,
      });
      link(graph, "instance_of", agent, node(graph, "spec", keys.spec(d.specName), d.specName));
      if (d.parentAgentId) {
        const parent = node(graph, "agent", keys.agent(d.parentAgentId), d.parentAgentId);
        link(graph, "spawned", parent, agent, { at: env.ts });
      }
      if (d.sandboxId) attachSandbox(graph, agent, d.sandboxId, undefined, env.ts);
      return;
    }
    case "agent.provisioned": {
      const r = AlineodEvents.AgentProvisioned.schema.safeParse(env.data);
      if (!r.success || r.data.agentId === null) return;
      const agent = node(graph, "agent", keys.agent(r.data.agentId), r.data.agentId);
      attachSandbox(graph, agent, r.data.sandboxId, r.data.provider, env.ts);
      return;
    }
    case "agent.restored": {
      const r = AlineodEvents.AgentRestored.schema.safeParse(env.data);
      if (!r.success || r.data.agentId === null) return;
      const agentKey = keys.agent(r.data.agentId);
      // `agent.restored` follows `agent.provisioned`, so the agent's current sandbox is the new one.
      const current = graph.hasNode(agentKey)
        ? graph.getNodeAttribute(agentKey, "sandboxId")
        : undefined;
      if (!current) return;
      link(
        graph,
        "restored_from",
        keys.sandbox(current),
        node(graph, "sandbox", keys.sandbox(r.data.oldSandboxId), r.data.oldSandboxId),
        { at: env.ts, checkpointTurn: r.data.checkpointTurn },
      );
      return;
    }
    case "agent.state_changed": {
      const r = AlineodEvents.AgentStateChanged.schema.safeParse(env.data);
      if (r.success && r.data.agentId !== null) {
        patchNode(graph, keys.agent(r.data.agentId), { state: r.data.to });
      }
      return;
    }
    case "agent.ended": {
      const r = AlineodEvents.AgentEnded.schema.safeParse(env.data);
      if (r.success && r.data.agentId !== null) {
        patchNode(graph, keys.agent(r.data.agentId), {
          outcome: r.data.outcome,
          ...(r.data.error !== undefined ? { error: r.data.error } : {}),
        });
      }
      return;
    }
    case "handle.settled": {
      const r = AlineodEvents.HandleSettled.schema.safeParse(env.data);
      if (!r.success || r.data.agentId === null) return;
      const agent = node(graph, "agent", keys.agent(r.data.agentId), r.data.agentId);
      if (r.data.resultRef !== null) {
        const result = keys.result(r.data.agentId);
        graph.mergeNode(result, {
          kind: "result",
          label: r.data.resultRef,
          resultRef: r.data.resultRef,
          outcome: r.data.outcome,
        });
        link(graph, "produced", agent, result, { at: env.ts });
      }
      return;
    }
    case "sandbox.created": {
      const r = SandboxEvents.SandboxCreated.schema.safeParse(env.data);
      if (!r.success) return;
      const sandbox = keys.sandbox(r.data.sandboxId);
      graph.mergeNode(sandbox, {
        kind: "sandbox",
        label: r.data.name,
        ...(r.data.provider !== undefined ? { provider: r.data.provider } : {}),
      });
      link(
        graph,
        "in_scope",
        sandbox,
        node(graph, "scope", keys.scope(r.data.runId), r.data.runId),
      );
      if (r.data.parentSandboxId) {
        const parent = node(
          graph,
          "sandbox",
          keys.sandbox(r.data.parentSandboxId),
          r.data.parentSandboxId,
        );
        link(graph, "forked_from", sandbox, parent, { at: env.ts });
      }
      return;
    }
    case "sandbox.closed": {
      const r = SandboxEvents.SandboxClosed.schema.safeParse(env.data);
      if (r.success) patchNode(graph, keys.sandbox(r.data.sandboxId), { closedAt: env.ts });
      return;
    }
    case "sandbox.checkpoint_created": {
      const r = SandboxEvents.SandboxCheckpointCreated.schema.safeParse(env.data);
      if (!r.success || !env.runId) return;
      // The sandbox is whichever one this stream's scope holds.
      const scope = keys.scope(env.runId);
      if (!graph.hasNode(scope)) return;
      const checkpoint = node(
        graph,
        "checkpoint",
        keys.checkpoint(r.data.snapshotId),
        r.data.snapshotId,
      );
      graph.forEachInNeighbor(scope, (sandbox) => {
        link(graph, "checkpointed", sandbox, checkpoint, { at: env.ts });
      });
      return;
    }
    case "agent.checkpointed": {
      const r = AgentEvents.AgentCheckpointed.schema.safeParse(env.data);
      if (!r.success || !env.agentId) return;
      const agent = node(graph, "agent", keys.agent(env.agentId), env.agentId);
      const checkpoint = node(
        graph,
        "checkpoint",
        keys.checkpoint(r.data.snapshotRef),
        r.data.snapshotRef,
      );
      link(graph, "checkpointed", agent, checkpoint, { at: env.ts, turn: r.data.turn });
      return;
    }
    case "permission.requested": {
      const r = AgentEvents.PermissionRequested.schema.safeParse(env.data);
      if (!r.success) return;
      const subject = subjectOf(graph, env);
      if (!subject) return;
      const permission = node(
        graph,
        "permission",
        keys.permission(r.data.requestId),
        `${r.data.tool} ${r.data.target}`,
      );
      link(graph, "requested", subject, permission, { at: env.ts });
      return;
    }
    case "permission.resolved": {
      const r = AgentEvents.PermissionResolved.schema.safeParse(env.data);
      if (r.success) {
        patchNode(graph, keys.permission(r.data.requestId), { decision: r.data.decision });
      }
      return;
    }
    case "budget.denied": {
      const r = AlineodEvents.BudgetDenied.schema.safeParse(env.data);
      if (!r.success || r.data.agentId === null) return;
      const agent = node(graph, "agent", keys.agent(r.data.agentId), r.data.agentId);
      const budget = node(graph, "budget", keys.budget(r.data.dimension), r.data.dimension);
      const key = `denied|${agent}|${budget}`;
      const count = graph.hasEdge(key) ? (graph.getEdgeAttribute(key, "count") ?? 0) : 0;
      graph.mergeEdgeWithKey(key, agent, budget, { kind: "denied", at: env.ts, count: count + 1 });
      return;
    }
    case "credential.bound": {
      const r = SandboxEvents.CredentialBound.schema.safeParse(env.data);
      if (!r.success) return;
      const subject = subjectOf(graph, env);
      if (!subject) return;
      const credential = node(graph, "credential", keys.credential(r.data.name), r.data.name);
      // A re-bind of a revoked credential makes it live again.
      const key = `holds|${subject}|${credential}`;
      if (graph.hasEdge(key)) graph.removeEdgeAttribute(key, "endedAt");
      link(graph, "holds", subject, credential, {
        at: env.ts,
        ...(r.data.injection !== undefined ? { injection: r.data.injection } : {}),
      });
      if (r.data.host) {
        link(
          graph,
          "scoped_to",
          credential,
          node(graph, "host", keys.host(r.data.host), r.data.host),
        );
      }
      return;
    }
    case "credential.revoked": {
      const r = SandboxEvents.CredentialRevoked.schema.safeParse(env.data);
      if (!r.success) return;
      const subject = subjectOf(graph, env);
      if (!subject) return;
      const key = `holds|${subject}|${keys.credential(r.data.name)}`;
      if (graph.hasEdge(key)) graph.mergeEdgeAttributes(key, { endedAt: env.ts });
      return;
    }
    case "egress.rule_added": {
      const r = SandboxEvents.EgressRuleAdded.schema.safeParse(env.data);
      if (!r.success) return;
      const rules = r.data.rules.filter(isNetworkRule);
      if (rules.length === 0) return;
      const subject = subjectOf(graph, env);
      if (!subject) return;
      for (const rule of rules) {
        const host = node(graph, "host", keys.host(rule.target), rule.target);
        // An incoming rule replaces the existing rule for the same target, in either direction.
        const opposite = rule.action === "allow" ? "egress_deny" : "egress_allow";
        const oppositeKey = `${opposite}|${subject}|${host}`;
        if (graph.hasEdge(oppositeKey)) graph.mergeEdgeAttributes(oppositeKey, { endedAt: env.ts });
        const kind = rule.action === "allow" ? "egress_allow" : "egress_deny";
        const key = `${kind}|${subject}|${host}`;
        if (graph.hasEdge(key)) graph.removeEdgeAttribute(key, "endedAt");
        link(graph, kind, subject, host, { at: env.ts });
      }
      return;
    }
    case "egress.rule_removed": {
      const r = SandboxEvents.EgressRuleRemoved.schema.safeParse(env.data);
      if (!r.success) return;
      const subject = subjectOf(graph, env);
      if (!subject) return;
      for (const target of r.data.targets) {
        for (const kind of ["egress_allow", "egress_deny"] as const) {
          const key = `${kind}|${subject}|${keys.host(target)}`;
          if (graph.hasEdge(key)) graph.mergeEdgeAttributes(key, { endedAt: env.ts });
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Fold a whole stream (a ledger read back, or a replayed run) into a fresh graph. */
export function buildGraph(envelopes: Iterable<LedgerEnvelope>): KnowledgeGraph {
  const graph = createKnowledgeGraph();
  for (const env of envelopes) apply(graph, env);
  return graph;
}

/** An `EventSink` that keeps `graph` current as events are emitted. Synchronous and non-throwing. */
export function graphSink(graph: KnowledgeGraph): (envelope: LedgerEnvelope) => void {
  return (envelope) => apply(graph, envelope);
}

import { describe, expect, it } from "vitest";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import { composeSinks } from "@alineo-labs/ledger";
import {
  agentsOfRun,
  ancestry,
  blastRadius,
  buildGraph,
  createKnowledgeGraph,
  credentialHolders,
  egressReach,
  explainPath,
  failedSubtree,
  graphSink,
  orphanSandboxes,
  pendingPermissions,
  sandboxLineage,
  subtree,
  targetMatches,
} from "../src/index";

let clock = 0;
const ev = (
  type: string,
  data: unknown,
  scope: { runId?: string; agentId?: string } = {},
): LedgerEnvelope => ({ v: 1, ts: (clock += 1), type, data, ...scope });

const spawned = (agentId: string, parentAgentId: string | null, sandboxId: string, depth = 0) =>
  ev("agent.spawned", {
    agentId,
    parentAgentId,
    runId: "r1",
    specName: "coder",
    depth,
    spawnIndex: 0,
    sandboxId,
  });

/** root → (a, b); a → c. b ends failed. */
function swarm(): LedgerEnvelope[] {
  return [
    ev("run.started", { runId: "r1" }),
    spawned("root", null, "sb-root"),
    spawned("a", "root", "sb-a", 1),
    spawned("b", "root", "sb-b", 1),
    spawned("c", "a", "sb-c", 2),
    ev("agent.state_changed", { agentId: "b", from: "running", to: "failed" }),
    ev("agent.state_changed", { agentId: "c", from: "running", to: "done" }),
  ];
}

describe("runtime graph", () => {
  it("answers ancestry and subtree from the spawn edges", () => {
    const g = buildGraph(swarm());
    expect(ancestry(g, "c")).toEqual(["a", "root"]);
    expect(ancestry(g, "root")).toEqual([]);
    expect(subtree(g, "root").map((d) => [d.agentId, d.depth])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 2],
    ]);
    expect(agentsOfRun(g, "r1")).toEqual(["root", "a", "b", "c"]);
  });

  it("reports only the descendants that did not finish", () => {
    const g = buildGraph(swarm());
    expect(failedSubtree(g, "root").map((d) => d.agentId)).toEqual(["b"]);
    expect(failedSubtree(g, "a")).toEqual([]);
  });

  it("returns nothing for an agent it has never seen", () => {
    const g = buildGraph(swarm());
    expect(subtree(g, "ghost")).toEqual([]);
    expect(ancestry(g, "ghost")).toEqual([]);
  });

  it("is idempotent: replaying the same ledger twice changes nothing", () => {
    const events = swarm();
    const once = buildGraph(events);
    const twice = buildGraph([...events, ...events]);
    expect(twice.order).toBe(once.order);
    expect(twice.size).toBe(once.size);
  });

  it("traces a restore back to the sandbox that was lost, and a fork to its parent", () => {
    const g = buildGraph([
      spawned("root", null, "sb-1"),
      ev("sandbox.created", {
        sandboxId: "sb-fork",
        name: "fork",
        runId: "s-fork",
        parentSandboxId: "sb-1",
      }),
      ev("agent.provisioned", { agentId: "root", sandboxId: "sb-2" }),
      ev("agent.restored", { agentId: "root", oldSandboxId: "sb-1", checkpointTurn: 3 }),
    ]);
    expect(sandboxLineage(g, "sb-2")).toEqual([
      { sandboxId: "sb-1", via: "restored_from", checkpointTurn: 3 },
    ]);
    expect(sandboxLineage(g, "sb-fork")).toEqual([{ sandboxId: "sb-1", via: "forked_from" }]);
  });

  it("flags live sandboxes the graph says should be gone", () => {
    const g = buildGraph([...swarm(), ev("sandbox.closed", { sandboxId: "sb-a" })]);
    const orphans = orphanSandboxes(g, ["sb-root", "sb-a", "sb-b", "sb-unknown"]);
    // sb-root's owner is still provisioning; sb-b's owner failed; sb-a was closed.
    expect(orphans).toEqual([
      { sandboxId: "sb-a", reason: "closed" },
      { sandboxId: "sb-b", reason: "owner-finished" },
      { sandboxId: "sb-unknown", reason: "unknown" },
    ]);
  });

  it("links a settled handle to its result", () => {
    const g = buildGraph([
      ...swarm(),
      ev("handle.settled", { agentId: "c", outcome: "done", resultRef: "/out/c.md" }),
    ]);
    expect(g.hasEdge("produced|agent:c|result:c")).toBe(true);
  });
});

describe("security graph", () => {
  const bound = (agentId: string, name: string, host?: string) =>
    ev("credential.bound", { name, host, injection: "header" }, { agentId });

  it("attributes a credential to its holders and marks revoked ones inactive", () => {
    const g = buildGraph([
      ...swarm(),
      bound("a", "GITHUB_TOKEN", "api.github.com"),
      bound("b", "GITHUB_TOKEN", "api.github.com"),
      ev("credential.revoked", { name: "GITHUB_TOKEN" }, { agentId: "b" }),
    ]);
    expect(credentialHolders(g, "GITHUB_TOKEN").map((h) => [h.agentId, h.active])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("a re-bind makes a revoked credential live again", () => {
    const g = buildGraph([
      ...swarm(),
      bound("a", "K"),
      ev("credential.revoked", { name: "K" }, { agentId: "a" }),
      bound("a", "K"),
    ]);
    expect(credentialHolders(g, "K")[0]?.active).toBe(true);
  });

  it("resolves a binding made on a sandbox's event stream to the agents that ran in it", () => {
    const g = buildGraph([
      ...swarm(),
      ev("sandbox.created", { sandboxId: "sb-a", name: "a", runId: "sess-a" }),
      ev(
        "credential.bound",
        { name: "NPM_TOKEN", host: "registry.npmjs.org" },
        { runId: "sess-a" },
      ),
    ]);
    expect(credentialHolders(g, "NPM_TOKEN").map((h) => h.agentId)).toEqual(["a"]);
  });

  it("blast radius adds the holders' descendants, labelled as potential", () => {
    const g = buildGraph([...swarm(), bound("a", "K")]);
    const radius = blastRadius(g, "K");
    expect(radius.holders.map((h) => h.agentId)).toEqual(["a"]);
    expect(radius.potentiallyReachable).toEqual(["c"]);
  });

  it("a revoked holder contributes no potentially-reachable descendants", () => {
    const g = buildGraph([
      ...swarm(),
      bound("a", "K"),
      ev("credential.revoked", { name: "K" }, { agentId: "a" }),
    ]);
    expect(blastRadius(g, "K").potentiallyReachable).toEqual([]);
  });

  it("finds who can reach a host, honouring wildcards, removals and replacement", () => {
    const g = buildGraph([
      ...swarm(),
      ev(
        "egress.rule_added",
        { rules: [{ action: "allow", target: "*.github.com" }] },
        { agentId: "a" },
      ),
      ev(
        "egress.rule_added",
        { rules: [{ action: "allow", target: "api.github.com" }] },
        { agentId: "b" },
      ),
      ev("egress.rule_removed", { targets: ["api.github.com"] }, { agentId: "b" }),
      ev(
        "egress.rule_added",
        { rules: [{ action: "allow", target: "api.github.com" }] },
        { agentId: "c" },
      ),
      ev(
        "egress.rule_added",
        { rules: [{ action: "deny", target: "api.github.com" }] },
        { agentId: "c" },
      ),
    ]);
    expect(egressReach(g, "api.github.com").map((r) => r.agentId)).toEqual(["a"]);
    expect(egressReach(g, "github.com")).toEqual([]);
  });

  it("lists permission requests nobody has answered", () => {
    const g = buildGraph([
      ...swarm(),
      ev(
        "permission.requested",
        { requestId: "p1", tool: "bash", target: "rm -rf /" },
        { agentId: "a" },
      ),
      ev(
        "permission.requested",
        { requestId: "p2", tool: "write", target: "x.ts" },
        { agentId: "b" },
      ),
      ev("permission.resolved", { requestId: "p2", decision: "allow" }),
    ]);
    expect(pendingPermissions(g)).toEqual([{ requestId: "p1", by: "a", what: "bash rm -rf /" }]);
  });

  it("explains how an agent reaches a host", () => {
    const g = buildGraph([...swarm(), bound("a", "GITHUB_TOKEN", "api.github.com")]);
    expect(explainPath(g, "agent:a", "host:api.github.com")).toEqual([
      { node: "agent:a" },
      { node: "credential:GITHUB_TOKEN", via: "holds" },
      { node: "host:api.github.com", via: "scoped_to" },
    ]);
    expect(explainPath(g, "agent:b", "host:api.github.com")).toBeNull();
    expect(explainPath(g, "agent:nope", "host:api.github.com")).toBeNull();
  });

  it("counts repeated budget denials on one edge", () => {
    const denied = () =>
      ev("budget.denied", { agentId: "a", dimension: "maxAgents", remaining: 0 });
    const g = buildGraph([...swarm(), denied(), denied(), denied()]);
    expect(g.getEdgeAttribute("denied|agent:a|budget:maxAgents", "count")).toBe(3);
  });

  it("matches wildcard targets against subdomains only", () => {
    expect(targetMatches("*.github.com", "api.github.com")).toBe(true);
    expect(targetMatches("*.github.com", "github.com")).toBe(false);
    expect(targetMatches("github.com", "github.com")).toBe(true);
  });
});

describe("folding", () => {
  it("ignores unknown events and malformed data without throwing", () => {
    const g = buildGraph([
      ev("something.unheard_of", {}),
      ev("agent.spawned", { agentId: 42 }),
      ev("credential.bound", "not an object", { agentId: "a" }),
      ev("egress.rule_added", { rules: [null, 3, { action: "allow" }] }, { agentId: "a" }),
    ]);
    expect(g.order).toBe(0);
  });

  it("keeps a graph current as a ledger sink", () => {
    const graph = createKnowledgeGraph();
    const sink = composeSinks([graphSink(graph)]);
    for (const e of swarm()) sink(e);
    expect(ancestry(graph, "c")).toEqual(["a", "root"]);
  });
});

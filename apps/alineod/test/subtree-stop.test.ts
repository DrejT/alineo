/** POST /agents/:id/stop — scope: subtree, finished agents (B8), and not-yet-forked spawns (B9). */
import { afterEach, describe, expect, test } from "bun:test";
import { get } from "../src/engine/registry";
import { getAgentRow, getHandle } from "../src/state/projection";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk, type FakeAgent } from "./fakes";

afterEach(() => fakeSdk.reset());

/** root → c1 → g1; `open` holds each turn open until resolved. */
async function tree() {
  const open = deferred();
  fakeSdk.nextTurn = { gate: open.promise };
  const run = await startRun({ spec: spec("root", { spawnDepth: 3 }), prompt: "lead" });
  fakeSdk.nextTurn = { gate: open.promise };
  const c1 = await spawnChild(run.runId, run.rootAgentId, { spec: spec("c1"), prompt: "work" });
  fakeSdk.nextTurn = { gate: open.promise };
  const g1 = await spawnChild(run.runId, c1.agentId, { spec: spec("g1"), prompt: "sub" });
  await until(() => getAgentRow(g1.agentId)?.state === "running", "g1 running");
  return { ...run, c1, g1, open };
}

function recordCloses(agents: Record<string, FakeAgent>): string[] {
  const order: string[] = [];
  for (const [name, agent] of Object.entries(agents)) {
    const original = agent.close.bind(agent);
    agent.close = async () => {
      order.push(name);
      await original();
    };
  }
  return order;
}

const byId = (body: { results: { agentId: string; outcome: string; reason?: string }[] }) =>
  Object.fromEntries(body.results.map((r) => [r.agentId, r]));

describe("stop with scope: subtree", () => {
  test("stops leaves first, ends every live member aborted, and returns one result per member", async () => {
    const t = await tree();
    const order = recordCloses({ root: t.root, c1: t.c1.agent, g1: t.g1.agent });

    const res = await call("POST", `/agents/${t.rootAgentId}/stop`, { scope: "subtree" });
    expect(res.status).toBe(200);
    expect(order).toEqual(["g1", "c1", "root"]);
    for (const id of [t.rootAgentId, t.c1.agentId, t.g1.agentId]) {
      expect(byId(res.body)[id]?.outcome).toBe("applied");
      expect(getAgentRow(id)).toMatchObject({ state: "aborted", outcome: "aborted" });
      expect(get(id)).toBeUndefined();
    }
    t.open.resolve();
  });

  test("a finished member is released with its outcome kept; a paused one is closed without abort", async () => {
    const t = await tree();
    fakeSdk.nextTurn = { text: "all done" };
    const quick = await spawnChild(t.runId, t.rootAgentId, { spec: spec("quick"), prompt: "go" });
    await until(() => getAgentRow(quick.agentId)?.state === "done", "quick to finish");
    await call("POST", `/agents/${t.c1.agentId}/pause`);

    const res = await call("POST", `/agents/${t.rootAgentId}/stop`, { scope: "subtree" });
    expect(byId(res.body)[quick.agentId]).toMatchObject({
      outcome: "applied",
      reason: "released (outcome kept)",
    });
    expect(getAgentRow(quick.agentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(quick.agent.closed).toBe(true);
    expect(
      events(t.runId).filter((e) => e.event === "agent_released" && e.agentId === quick.agentId),
    ).toHaveLength(1);

    expect(t.c1.agent.aborted).toBe(false);
    expect(t.c1.agent.closed).toBe(true);
    expect(getAgentRow(t.c1.agentId)?.outcome).toBe("aborted");
    t.open.resolve();
  });

  test("a waitFor dependent outside the stopped subtree is released and proceeds", async () => {
    const t = await tree();
    const res = await call("POST", `/runs/${t.runId}/agents`, {
      parentAgentId: t.rootAgentId,
      spec: spec("gather"),
      waitFor: [t.c1.agentId],
      prompt: "gather",
    });
    await call("POST", `/agents/${t.c1.agentId}/stop`, { scope: "subtree" });
    await until(() => getAgentRow(res.body.agentId as string)?.sandbox_id, "gather to fork");
    expect(getHandle(t.c1.agentId)).toMatchObject({ state: "settled", outcome: "aborted" });
    t.open.resolve();
  });

  test("an already-ended member is skipped, and an unknown root is 404", async () => {
    const t = await tree();
    await call("POST", `/agents/${t.g1.agentId}/stop`);
    const res = await call("POST", `/agents/${t.rootAgentId}/stop`, { scope: "subtree" });
    expect(byId(res.body)[t.g1.agentId]).toMatchObject({ outcome: "skipped", reason: "not-live" });
    expect((await call("POST", "/agents/a_missing/stop", { scope: "subtree" })).status).toBe(404);
    t.open.resolve();
  });
});

describe("stop on a finished agent (B8)", () => {
  test("closes its sandbox but keeps success, recording agent_released instead of agent_ended", async () => {
    const { runId, rootAgentId, root } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    expect((await call("POST", `/agents/${rootAgentId}/stop`)).status).toBe(202);
    expect(root.closed).toBe(true);
    expect(root.aborted).toBe(false);
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(events(runId).filter((e) => e.event === "agent_ended")).toHaveLength(1);
    expect(events(runId).some((e) => e.event === "agent_released")).toBe(true);
  });
});

describe("stop before the fork (B9)", () => {
  test("a child held on waitFor never forks once stopped", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    const depGate = deferred();
    fakeSdk.nextTurn = { gate: depGate.promise };
    const dep = await spawnChild(run.runId, run.rootAgentId, { prompt: "slow" });

    const held = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("gather"),
      waitFor: [dep.agentId],
    });
    const heldId = held.body.agentId as string;
    await call("POST", `/agents/${heldId}/stop`);
    depGate.resolve();

    await until(() => getHandle(dep.agentId)?.state === "settled", "dep to settle");
    await Bun.sleep(100);
    expect(run.root.spawns.map((s) => s.child.name)).not.toContain("gather");
    expect(getAgentRow(heldId)).toMatchObject({ state: "aborted", outcome: "aborted" });
  });

  test("a fork that lands after the stop is closed, not registered, and stays aborted", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    const forkGate = deferred();
    run.root.forkGate = forkGate.promise;

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("late"),
      prompt: "never",
    });
    const id = res.body.agentId as string;
    await Bun.sleep(30); // the fork is in flight, waiting on the gate
    await call("POST", `/agents/${id}/stop`);
    forkGate.resolve();

    await until(() => run.root.spawns.length === 1, "the fork to return");
    const child = run.root.spawns[0]?.child;
    await until(() => child?.closed, "the late fork to be closed");
    expect(get(id)).toBeUndefined();
    expect(child?.prompts).toEqual([]);
    expect(getAgentRow(id)).toMatchObject({ state: "aborted", outcome: "aborted" });
    expect(
      events(run.runId).find((e) => e.event === "agent_released" && e.agentId === id)?.reason,
    ).toBe("stopped-before-provisioned");
  });

  test("spawning under a stopped parent is 409", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    await call("POST", `/agents/${run.rootAgentId}/stop`);
    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("child"),
    });
    expect(res.status).toBe(409);
  });
});

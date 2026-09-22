/** POST /agents/:id/{pause,resume} with `scope: "subtree"` (research/tier-1-2-plan.md §3). */
import { afterEach, describe, expect, test } from "bun:test";
import { forget } from "../src/engine/registry";
import { rehydrate } from "../src/engine/rehydrate";
import { getAgentRow } from "../src/state/projection";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk, type FakeAgent } from "./fakes";

afterEach(() => fakeSdk.reset());

/** root → c1 → g1, every turn held open by one gate so all three stay `running`. */
async function tree() {
  const gate = deferred();
  fakeSdk.nextTurn = { gate: gate.promise };
  const run = await startRun({ spec: spec("root", { spawnDepth: 3 }), prompt: "lead" });
  fakeSdk.nextTurn = { gate: gate.promise };
  const c1 = await spawnChild(run.runId, run.rootAgentId, { spec: spec("c1"), prompt: "work" });
  fakeSdk.nextTurn = { gate: gate.promise };
  const g1 = await spawnChild(run.runId, c1.agentId, { spec: spec("g1"), prompt: "sub" });
  await until(() => getAgentRow(g1.agentId)?.state === "running", "g1 running");
  return { ...run, c1, g1, gate };
}

/** Record the order sandboxes are paused/resumed in. */
function recordOrder(agents: Record<string, FakeAgent>, method: "pause" | "resume"): string[] {
  const order: string[] = [];
  for (const [name, agent] of Object.entries(agents)) {
    const original = agent.sandbox[method];
    agent.sandbox[method] = async () => {
      order.push(name);
      await original();
    };
  }
  return order;
}

const outcomes = (body: { results: { agentId: string; outcome: string; reason?: string }[] }) =>
  Object.fromEntries(body.results.map((r) => [r.agentId, r]));

describe("pause / resume with scope: subtree", () => {
  test("pauses parents first and resumes children first, recording who paused each", async () => {
    const t = await tree();
    const agents = { root: t.root, c1: t.c1.agent, g1: t.g1.agent };
    const pauseOrder = recordOrder(agents, "pause");

    const res = await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "subtree" });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(pauseOrder).toEqual(["root", "c1", "g1"]);
    expect(getAgentRow(t.rootAgentId)).toMatchObject({ state: "paused", paused_by: "operator" });
    expect(getAgentRow(t.c1.agentId)).toMatchObject({ state: "paused", paused_by: "cascade" });
    expect(getAgentRow(t.g1.agentId)).toMatchObject({ state: "paused", paused_by: "cascade" });
    expect((await call("GET", `/agents/${t.c1.agentId}`)).body.pausedBy).toBe("cascade");

    const resumeOrder = recordOrder(agents, "resume");
    const back = await call("POST", `/agents/${t.rootAgentId}/resume`, { scope: "subtree" });
    expect(back.status).toBe(200);
    expect(resumeOrder).toEqual(["g1", "c1", "root"]);
    for (const id of [t.rootAgentId, t.c1.agentId, t.g1.agentId]) {
      expect(getAgentRow(id)).toMatchObject({ state: "running", paused_by: null });
    }
    const cascade = events(t.runId).filter(
      (e) => e.event === "agent.state_changed" && e.to === "paused" && e.pausedBy === "cascade",
    );
    expect(cascade.map((e) => e.agentId).sort()).toEqual([t.c1.agentId, t.g1.agentId].sort());
    t.gate.resolve();
  });

  test("a member that was already paused keeps its own provenance and is reported skipped", async () => {
    const t = await tree();
    await call("POST", `/agents/${t.c1.agentId}/pause`);

    const res = await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "subtree" });
    expect(outcomes(res.body)[t.c1.agentId]).toMatchObject({
      outcome: "skipped",
      reason: "already-paused",
    });
    expect(getAgentRow(t.c1.agentId)?.paused_by).toBe("operator");
    t.gate.resolve();
  });

  test("a stopped member is skipped, and one member failing doesn't block the rest", async () => {
    const t = await tree();
    await call("POST", `/agents/${t.g1.agentId}/stop`);
    t.c1.agent.pauseError = new Error("runtime refused");

    const res = await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "subtree" });
    const by = outcomes(res.body);
    expect(by[t.rootAgentId]?.outcome).toBe("applied");
    expect(by[t.c1.agentId]).toMatchObject({ outcome: "failed" });
    expect(by[t.c1.agentId]?.reason).toContain("runtime refused");
    expect(by[t.g1.agentId]).toMatchObject({ outcome: "skipped", reason: "not-live" });
    t.gate.resolve();
  });

  test("a member's failure reason unwraps OpenSandbox's raw JSON error body", async () => {
    const t = await tree();
    t.c1.agent.pauseError = new Error(
      JSON.stringify({ code: "DOCKER::SANDBOX_NOT_FOUND", message: "Sandbox sb-9 not found." }),
    );

    const res = await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "subtree" });
    expect(outcomes(res.body)[t.c1.agentId]).toMatchObject({
      outcome: "failed",
      reason: "pause failed: Sandbox sb-9 not found. (DOCKER::SANDBOX_NOT_FOUND)",
    });
    t.gate.resolve();
  });

  test("a child that forks under a paused ancestor joins the pause and runs its prompt on resume", async () => {
    const t = await tree();
    await call("POST", `/agents/${t.rootAgentId}/pause`); // root only — c1 keeps running

    const g2 = await spawnChild(t.runId, t.c1.agentId, { spec: spec("g2"), prompt: "late" });
    await until(() => getAgentRow(g2.agentId)?.state === "paused", "g2 to join the pause");
    expect(getAgentRow(g2.agentId)?.paused_by).toBe("cascade");
    expect(g2.agent.prompts).toEqual([]);

    await call("POST", `/agents/${g2.agentId}/resume`);
    await until(() => g2.agent.prompts.includes("late"), "g2's deferred prompt");
    t.gate.resolve();
  });

  test("a member that hasn't forked yet is reported pending, then forks and runs after resume", async () => {
    const t = await tree();
    const depGate = deferred();
    fakeSdk.nextTurn = { gate: depGate.promise, text: "dep result" };
    const dep = await spawnChild(t.runId, t.rootAgentId, { spec: spec("dep"), prompt: "dep" });

    const held = await call("POST", `/runs/${t.runId}/agents`, {
      parentAgentId: t.c1.agentId,
      spec: spec("gather"),
      waitFor: [dep.agentId],
      prompt: "gather",
    });
    const gatherId = held.body.agentId as string;

    const res = await call("POST", `/agents/${t.c1.agentId}/pause`, { scope: "subtree" });
    expect(outcomes(res.body)[gatherId]).toMatchObject({ outcome: "applied" });
    expect(outcomes(res.body)[gatherId]?.reason).toContain("pending");

    depGate.resolve(); // dep (outside the paused subtree) settles; gather now waits on paused c1
    await until(
      () => events(t.runId).some((e) => e.agentId === gatherId && e.reason === "parent-paused"),
      "gather held on its paused parent",
    );
    expect(getAgentRow(gatherId)?.sandbox_id).toBeNull();

    await call("POST", `/agents/${t.c1.agentId}/resume`, { scope: "subtree" });
    const gather = await until(
      () => t.c1.agent.spawns.find((s) => s.child.name === "gather")?.child,
      "gather to fork",
    );
    await until(() => gather.prompts.includes("gather"), "gather's prompt");
    t.gate.resolve();
  });

  test("a subtree paused across a daemon restart comes back paused and resumes", async () => {
    const t = await tree();
    await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "subtree" });

    for (const id of [t.rootAgentId, t.c1.agentId, t.g1.agentId]) forget(id);
    await rehydrate();
    // rehydrate() reconnects every agent in the shared test DB; only this tree matters here —
    // none of its paused sandboxes may have had their bridge restarted.
    const ours = [t.root, t.c1.agent, t.g1.agent].map((a) => a.sandboxId);
    expect(fakeSdk.calls.resume.filter((id) => ours.includes(id))).toEqual([]);
    for (const id of [t.rootAgentId, t.c1.agentId, t.g1.agentId]) {
      expect(getAgentRow(id)?.state).toBe("paused");
    }

    const res = await call("POST", `/agents/${t.rootAgentId}/resume`, { scope: "subtree" });
    expect(res.body.results.every((r: { outcome: string }) => r.outcome === "applied")).toBe(true);
    t.gate.resolve();
  });

  test("scope defaults to the single agent, and an unknown root is 404", async () => {
    const t = await tree();
    const res = await call("POST", `/agents/${t.rootAgentId}/pause`, {});
    expect(res.status).toBe(202);
    expect(getAgentRow(t.c1.agentId)?.state).toBe("running");
    expect((await call("POST", "/agents/a_missing/pause", { scope: "subtree" })).status).toBe(404);
    expect((await call("POST", `/agents/${t.rootAgentId}/pause`, { scope: "nope" })).status).toBe(
      400,
    );
    t.gate.resolve();
  });
});

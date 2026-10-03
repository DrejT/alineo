/** POST /swarms/plan (planning), POST /swarms (realization via the existing runs/agents engine). */
import { afterEach, describe, expect, test } from "bun:test";
import { call, until } from "./helpers";
import { fakeSdk, fakeModel } from "./fakes";

afterEach(() => {
  fakeSdk.reset();
  fakeModel.nextPlan = undefined;
  fakeModel.nextError = undefined;
});

function validPlan() {
  return {
    nodes: [
      { id: "coordinator", role: "coordinator", task: "split the work", parentId: null },
      { id: "worker-1", role: "worker", task: "fix auth", parentId: "coordinator" },
    ],
    spawnDepth: 2,
    maxAgents: 2,
  };
}

describe("POST /swarms/plan", () => {
  test("returns the model's plan when it's realizable", async () => {
    fakeModel.nextPlan = validPlan();
    const res = await call("POST", "/swarms/plan", { prompt: "fix the auth module" });
    expect(res.status).toBe(200);
    expect(res.body.ambiguous).toBe(false);
    expect(res.body.violatesLimits).toEqual([]);
    expect(fakeModel.lastPrompt).toBe("fix the auth module");
  });

  test("flags a plan with no root as ambiguous", async () => {
    fakeModel.nextPlan = {
      nodes: [{ id: "a", role: "x", task: "y", parentId: "b" }],
      spawnDepth: 1,
      maxAgents: 1,
    };
    const res = await call("POST", "/swarms/plan", { prompt: "do something vague" });
    expect(res.status).toBe(200);
    expect(res.body.ambiguous).toBe(true);
  });

  test("flags a plan that exceeds the spawn-depth ceiling", async () => {
    fakeModel.nextPlan = { ...validPlan(), spawnDepth: 999 };
    const res = await call("POST", "/swarms/plan", { prompt: "spin up a huge swarm" });
    expect(res.status).toBe(200);
    expect(res.body.violatesLimits.some((p: string) => p.includes("ceiling"))).toBe(true);
  });

  test("400 for an empty prompt", async () => {
    expect((await call("POST", "/swarms/plan", { prompt: "" })).status).toBe(400);
  });
});

describe("POST /swarms", () => {
  test("creates the root run and spawns children in dependency order", async () => {
    const res = await call("POST", "/swarms", validPlan());
    expect(res.status).toBe(202);
    expect(res.body.agentIds.coordinator).toMatch(/^a_/);

    // worker-1 is only assigned once realizeRest's background loop reaches it — poll the run.
    const tree = await until(async () => {
      const t = await call("GET", `/runs/${res.body.runId}`);
      return t.body.agents.length === 2 ? t.body : null;
    });
    expect(tree.agents.map((a: { specName: string }) => a.specName).sort()).toEqual([
      "coordinator",
      "worker-1",
    ]);
  });

  test("422 for a plan that doesn't validate", async () => {
    const res = await call("POST", "/swarms", {
      nodes: [{ id: "a", role: "x", task: "y", parentId: "b" }],
      spawnDepth: 1,
      maxAgents: 1,
    });
    expect(res.status).toBe(422);
  });
});

/** POST /swarms/plan (planning), POST /swarms (realization over alineod's HTTP API). */
import { afterEach, describe, expect, test } from "bun:test";
import { call, until } from "./helpers";
import { fakeModel } from "./fakes";
import { fakeAlineod } from "./fake-alineod";

afterEach(() => {
  fakeAlineod.reset();
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
    expect(res.body.runId).toBe("run_1");
    expect(res.body.agentIds.coordinator).toBe("a_root");

    // The child is spawned by the background loop — poll alineod's recorded calls.
    const spawn = await until(
      () => fakeAlineod.calls.find((c) => c.method === "POST" && c.path === "/runs/run_1/agents"),
      "child spawn",
    );
    expect(spawn.body).toMatchObject({ parentAgentId: "a_root", prompt: "fix auth" });

    const root = fakeAlineod.calls.find((c) => c.method === "POST" && c.path === "/runs");
    expect(root?.body).toMatchObject({ prompt: "split the work", budget: { spawnDepth: 2, maxAgents: 2 } });
  });

  test("retries the child spawn while alineod says the parent is not live yet", async () => {
    fakeAlineod.notLive.add("a_root");
    await call("POST", "/swarms", validPlan());
    await until(
      () => fakeAlineod.calls.filter((c) => c.path === "/runs/run_1/agents").length >= 2,
      "a retried spawn",
    );
    fakeAlineod.notLive.delete("a_root");
    await until(() => fakeAlineod.nextAgent >= 1, "the child to spawn once the parent is live");
  });

  test("gives up on a child whose parent failed", async () => {
    fakeAlineod.notLive.add("a_root");
    fakeAlineod.agentState.set("a_root", "failed");
    await call("POST", "/swarms", validPlan());
    await until(() => fakeAlineod.calls.some((c) => c.path === "/agents/a_root"), "parent check");
    const spawns = fakeAlineod.calls.filter((c) => c.path === "/runs/run_1/agents").length;
    await Bun.sleep(100);
    expect(fakeAlineod.calls.filter((c) => c.path === "/runs/run_1/agents").length).toBe(spawns);
  });

  test("502 when alineod is unreachable for the root run", async () => {
    fakeAlineod.down = true;
    const res = await call("POST", "/swarms", validPlan());
    expect(res.status).toBe(503);
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

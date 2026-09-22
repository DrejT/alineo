/** POST /runs, GET /runs/:id, DELETE /runs/:id, GET /health. */
import { afterEach, describe, expect, test } from "bun:test";
import { getAgentRow } from "../src/state/projection";
import { call, deferred, events, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

test("GET /health", async () => {
  expect(await call("GET", "/health")).toEqual({ status: 200, body: { ok: true } });
});

describe("POST /runs", () => {
  test("accepts immediately and records the root before provisioning finishes", async () => {
    const gate = deferred();
    fakeSdk.startGate = gate.promise;

    const res = await call("POST", "/runs", { spec: spec("coordinator") });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: "provisioning" });
    expect(res.body.runId).toMatch(/^r_/);
    expect(res.body.rootAgentId).toMatch(/^a_/);

    const tree = await call("GET", `/runs/${res.body.runId}`);
    expect(tree.status).toBe(200);
    expect(tree.body.rootAgentId).toBe(res.body.rootAgentId);
    expect(tree.body.agents).toEqual([
      expect.objectContaining({
        agentId: res.body.rootAgentId,
        parentAgentId: null,
        depth: 0,
        state: "provisioning",
        specName: "coordinator",
        sandboxId: null,
      }),
    ]);

    gate.resolve();
    const view = await until(
      async () => (await call("GET", `/agents/${res.body.rootAgentId}`)).body.sandboxId,
    );
    expect(view).toMatch(/^sb-/);
    expect(events(res.body.runId).map((e) => e.event)).toEqual([
      "run.started",
      "agent.spawned",
      "agent.provisioned",
    ]);
  });

  test("runs the first prompt and settles the root's result", async () => {
    const { runId, rootAgentId, root } = await startRun({ prompt: "say hi" });
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");

    expect(root.prompts).toEqual(["say hi"]);
    const result = await call("GET", `/agents/${rootAgentId}/result`);
    expect(result).toEqual({
      status: 200,
      body: {
        agentId: rootAgentId,
        state: "settled",
        outcome: "success",
        resultRef: `fs://${rootAgentId}/result.md`,
        result: "reply: say hi",
      },
    });
    expect(events(runId).map((e) => e.event)).toContain("handle.settled");
  });

  test("a provisioning failure ends the root as failed with the error", async () => {
    fakeSdk.startError = new Error("image pull failed");
    const res = await call("POST", "/runs", { spec: spec("root") });
    expect(res.status).toBe(202);

    const view = await until(async () => {
      const r = await call("GET", `/agents/${res.body.rootAgentId}`);
      return r.body.outcome ? r.body : null;
    });
    expect(view).toMatchObject({ state: "failed", outcome: "failed", sandboxId: null });
    expect(events(res.body.runId).find((e) => e.event === "agent.ended")?.error).toBe(
      "image pull failed",
    );
  });

  test("records the spec's budgets, and a request budget overrides them", async () => {
    const fromSpec = await call("POST", "/runs", {
      spec: spec("root", { spawnDepth: 3, maxAgents: 9 }),
    });
    expect(getAgentRow(fromSpec.body.rootAgentId)).toMatchObject({
      spawn_budget: 3,
      max_agents_budget: 9,
    });

    const overridden = await call("POST", "/runs", {
      spec: spec("root", { spawnDepth: 3, maxAgents: 9 }),
      budget: { spawnDepth: 1, maxAgents: 2 },
    });
    expect(getAgentRow(overridden.body.rootAgentId)).toMatchObject({
      spawn_budget: 1,
      max_agents_budget: 2,
    });
  });

  test.each([
    ["no spec", { prompt: "hi" }],
    ["a non-object spec", { spec: "agent.json" }],
    ["a negative budget", { spec: { name: "x" }, budget: { spawnDepth: -1 } }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await call("POST", "/runs", body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid request body");
  });
});

describe("GET /runs/:runId", () => {
  test("404 for an unknown run", async () => {
    expect((await call("GET", "/runs/r_missing")).status).toBe(404);
  });

  test("asOf is the highest ledger seq in the run", async () => {
    const { runId } = await startRun();
    const tree = await call("GET", `/runs/${runId}`);
    expect(tree.body.asOf).toBe(Math.max(...events(runId).map((e) => e.seq)));
  });
});

describe("DELETE /runs/:runId", () => {
  test("aborts and closes every live agent but keeps the run's history", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { runId, rootAgentId, root } = await startRun({ prompt: "long task" });

    const res = await call("DELETE", `/runs/${runId}`);
    expect(res.status).toBe(204);
    expect(root.aborted).toBe(true);
    expect(root.closed).toBe(true);

    const tree = await call("GET", `/runs/${runId}`);
    expect(tree.status).toBe(200);
    expect(tree.body.agents[0]).toMatchObject({
      agentId: rootAgentId,
      state: "aborted",
      outcome: "aborted",
    });
    expect((await call("POST", `/agents/${rootAgentId}/steer`, { message: "x" })).status).toBe(409);
    gate.resolve();
  });

  test("closes a finished agent's still-open sandbox too, keeping its outcome", async () => {
    const { runId, rootAgentId, root } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(204);
    expect(root.closed).toBe(true);
    expect(root.aborted).toBe(false);
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(events(runId).filter((e) => e.event === "agent.ended")).toHaveLength(1);
  });

  test("404 for an unknown run", async () => {
    expect((await call("DELETE", "/runs/r_missing")).status).toBe(404);
  });
});

/** POST /runs/:runId/agents — forking, budgets, waitFor, and idempotency. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAgentRow } from "../src/state/projection";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

const root = { spec: spec("root", { spawnDepth: 2 }) };

async function endedView(agentId: string) {
  return until(async () => {
    const r = await call("GET", `/agents/${agentId}`);
    return r.body.outcome ? r.body : null;
  }, `${agentId} to end`);
}

describe("spawning a child", () => {
  test("accepts immediately, then forks the parent's sandbox and runs the child's prompt", async () => {
    const run = await startRun(root);

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("worker"),
      prompt: "handle auth",
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ agentId: expect.stringMatching(/^a_/), state: "provisioning" });

    const childId = res.body.agentId;
    const sandboxId = await until(
      async () => (await call("GET", `/agents/${childId}`)).body.sandboxId,
    );
    const fork = run.root.spawns[0]!;
    expect(fork.child.sandboxId).toBe(sandboxId);
    expect(JSON.parse(readFileSync(fork.specPath, "utf8"))).toEqual(spec("worker"));
    await until(() => fork.child.prompts.includes("handle auth"));

    expect((await call("GET", `/agents/${childId}`)).body).toMatchObject({
      runId: run.runId,
      parentAgentId: run.rootAgentId,
      depth: 1,
      spawnIndex: 0,
      specName: "worker",
    });
  });

  test("concurrent spawns under one parent get distinct spawnIndex values", async () => {
    const run = await startRun(root);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        call("POST", `/runs/${run.runId}/agents`, {
          parentAgentId: run.rootAgentId,
          spec: spec("w"),
        }),
      ),
    );
    const indexes = results.map((r) => getAgentRow(r.body.agentId)!.spawn_index).sort();
    expect(indexes).toEqual([0, 1, 2]);
  });

  test("forks of the same parent are serialized, never overlapping against its sandbox (OpenSandbox#1831)", async () => {
    const run = await startRun(root);
    const gate = deferred();
    run.root.forkGate = gate.promise; // stretch the in-flight window so any overlap gets caught

    const [a, b] = await Promise.all([
      call("POST", `/runs/${run.runId}/agents`, {
        parentAgentId: run.rootAgentId,
        spec: spec("w1"),
      }),
      call("POST", `/runs/${run.runId}/agents`, {
        parentAgentId: run.rootAgentId,
        spec: spec("w2"),
      }),
    ]);
    await Bun.sleep(20); // let both requests' background provisionChild() reach the fork
    gate.resolve();

    const [aView, bView] = await Promise.all(
      [a.body.agentId, b.body.agentId].map((id) =>
        until(async () => {
          const r = await call("GET", `/agents/${id}`);
          return r.body.sandboxId || r.body.outcome ? r.body : null;
        }),
      ),
    );

    expect(aView).toMatchObject({ sandboxId: expect.stringMatching(/^sb-/), outcome: null });
    expect(bView).toMatchObject({ sandboxId: expect.stringMatching(/^sb-/), outcome: null });
    expect(run.root.spawns).toHaveLength(2);
  });

  test.each([
    ["no parentAgentId", { spec: { name: "w" } }, 400],
    ["no spec", { parentAgentId: "PARENT" }, 400],
    ["a parent from another run", { parentAgentId: "OTHER", spec: { name: "w" } }, 404],
    ["an unknown parent", { parentAgentId: "a_missing", spec: { name: "w" } }, 404],
    [
      "waitFor on an unknown agent",
      { parentAgentId: "PARENT", spec: { name: "w" }, waitFor: ["a_missing"] },
      400,
    ],
  ])("rejects %s", async (_label, body, status) => {
    const run = await startRun(root);
    const other = await startRun(root);
    const resolved = JSON.parse(
      JSON.stringify(body).replace("PARENT", run.rootAgentId).replace("OTHER", other.rootAgentId),
    );
    expect((await call("POST", `/runs/${run.runId}/agents`, resolved)).status).toBe(status);
  });

  test("409 when the parent isn't live", async () => {
    const run = await startRun(root);
    await call("POST", `/agents/${run.rootAgentId}/stop`);
    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("w"),
    });
    expect(res.status).toBe(409);
  });
});

describe("budgets", () => {
  test("hands the parent's remaining budget to spawn() and records one less on the child", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 2, maxAgents: 5 }) });
    const child = await spawnChild(run.runId, run.rootAgentId);

    expect(run.root.spawns[0]!.opts).toEqual({ spawnDepth: 2, maxAgents: 5 });
    expect(getAgentRow(child.agentId)).toMatchObject({ spawn_budget: 1, max_agents_budget: 4 });
  });

  test("a request budget overrides the parent's", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    const child = await spawnChild(run.runId, run.rootAgentId, { budget: { spawnDepth: 5 } });
    expect(run.root.spawns[0]!.opts.spawnDepth).toBe(5);
    expect(getAgentRow(child.agentId)?.spawn_budget).toBe(4);
  });

  test("an exhausted spawn depth ends the child as budget-exceeded and emits budget_denied", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 1 }) });
    const child = await spawnChild(run.runId, run.rootAgentId);

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: child.agentId,
      spec: spec("grandchild"),
    });
    expect(res.status).toBe(202);

    expect(await endedView(res.body.agentId)).toMatchObject({
      state: "failed",
      outcome: "budget-exceeded",
      depth: 2,
    });
    expect(events(run.runId).filter((e) => e.event === "budget_denied")).toEqual([
      expect.objectContaining({ agentId: child.agentId, dimension: "spawnDepth", remaining: 0 }),
    ]);
    expect(child.agent.spawns).toHaveLength(0);
  });

  test("a root with no spawnDepth can't spawn at all", async () => {
    const run = await startRun({ spec: spec("root") });
    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("w"),
    });
    expect(await endedView(res.body.agentId)).toMatchObject({ outcome: "budget-exceeded" });
  });

  test("an exhausted maxAgents is reported as the maxAgents dimension", async () => {
    const run = await startRun({ spec: spec("root", { spawnDepth: 3, maxAgents: 1 }) });
    const child = await spawnChild(run.runId, run.rootAgentId);

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: child.agentId,
      spec: spec("grandchild"),
    });
    expect(await endedView(res.body.agentId)).toMatchObject({ outcome: "budget-exceeded" });
    expect(events(run.runId).find((e) => e.event === "budget_denied")).toMatchObject({
      dimension: "maxAgents",
    });
  });
});

describe("waitFor", () => {
  test("holds the child until every dependency settles, then injects their results", async () => {
    const run = await startRun(root);
    const gateA = deferred();
    fakeSdk.nextTurn = { gate: gateA.promise, text: "haiku about the ocean" };
    const a = await spawnChild(run.runId, run.rootAgentId, {
      spec: spec("worker-a"),
      prompt: "ocean",
    });
    fakeSdk.nextTurn = { text: null, error: "provider 500" };
    const b = await spawnChild(run.runId, run.rootAgentId, {
      spec: spec("worker-b"),
      prompt: "desert",
    });
    await until(async () => (await call("GET", `/agents/${b.agentId}/result`)).status === 200);

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("gather"),
      waitFor: [a.agentId, b.agentId],
      prompt: "combine",
    });
    expect(res.body.state).toBe("spawning");
    const gatherId = res.body.agentId;

    await Bun.sleep(100);
    expect((await call("GET", `/agents/${gatherId}`)).body).toMatchObject({
      state: "spawning",
      sandboxId: null,
    });
    expect(run.root.spawns).toHaveLength(2);

    gateA.resolve();
    await until(
      async () => (await call("GET", `/agents/${gatherId}`)).body.sandboxId,
      "gather to fork",
    );
    const gather = run.root.spawns[2]!.child;

    expect(gather.files.get(`/inputs/${a.agentId}.txt`)).toBe("haiku about the ocean");
    expect(gather.files.get(`/inputs/${b.agentId}.txt`)).toBe("");
    expect(JSON.parse(gather.files.get("/inputs.json")!)).toEqual({
      [a.agentId]: { path: `/inputs/${a.agentId}.txt`, outcome: "success" },
      [b.agentId]: { path: `/inputs/${b.agentId}.txt`, outcome: "failed" },
    });
    await until(() => gather.prompts.includes("combine"));

    const transitions = events(run.runId).filter(
      (e) => e.event === "agent_state_changed" && e.agentId === gatherId,
    );
    expect(transitions.map((e) => e.reason)).toEqual(["waitFor", "deps-settled", "prompt"]);
  });

  test("fails the held child if its parent is gone by the time the dependencies settle", async () => {
    const run = await startRun(root);
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const dep = await spawnChild(run.runId, run.rootAgentId, { prompt: "slow" });

    const res = await call("POST", `/runs/${run.runId}/agents`, {
      parentAgentId: run.rootAgentId,
      spec: spec("gather"),
      waitFor: [dep.agentId],
    });
    await call("POST", `/agents/${run.rootAgentId}/stop`);
    gate.resolve();

    expect(await endedView(res.body.agentId)).toMatchObject({ outcome: "failed" });
    expect(
      events(run.runId).find((e) => e.event === "agent_ended" && e.agentId === res.body.agentId)
        ?.error,
    ).toContain("no longer live");
  });
});

describe("idempotencyKey", () => {
  test("a retried request returns the original child and forks only once", async () => {
    const run = await startRun(root);
    const body = {
      parentAgentId: run.rootAgentId,
      spec: spec("w"),
      idempotencyKey: "review-auth-1",
    };

    const first = await call("POST", `/runs/${run.runId}/agents`, body);
    const retry = await call("POST", `/runs/${run.runId}/agents`, body);
    expect(retry.status).toBe(202);
    expect(retry.body.agentId).toBe(first.body.agentId);

    await until(async () => (await call("GET", `/agents/${first.body.agentId}`)).body.sandboxId);
    expect(run.root.spawns).toHaveLength(1);
    expect((await call("GET", `/runs/${run.runId}`)).body.agents).toHaveLength(2);
  });

  test("keys are scoped to their run", async () => {
    const one = await startRun(root);
    const two = await startRun(root);
    const a = await call("POST", `/runs/${one.runId}/agents`, {
      parentAgentId: one.rootAgentId,
      spec: spec("w"),
      idempotencyKey: "k",
    });
    const b = await call("POST", `/runs/${two.runId}/agents`, {
      parentAgentId: two.rootAgentId,
      spec: spec("w"),
      idempotencyKey: "k",
    });
    expect(a.body.agentId).not.toBe(b.body.agentId);
  });
});

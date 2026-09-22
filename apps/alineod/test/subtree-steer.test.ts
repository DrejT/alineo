/** POST /agents/:id/steer with scope: "subtree" — steer through the parent (research/tier-1-2-plan.md #6). */
import { afterEach, describe, expect, test } from "bun:test";
import { getAgentRow } from "../src/state/projection";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

async function family(parentTurn: { gate?: Promise<void> } = {}) {
  fakeSdk.nextTurn = parentTurn;
  const run = await startRun({ spec: spec("lead", { spawnDepth: 3 }), prompt: "lead the work" });
  fakeSdk.nextTurn = { gate: deferred().promise };
  const a = await spawnChild(run.runId, run.rootAgentId, {
    spec: spec("worker-auth"),
    prompt: "review the auth module",
  });
  fakeSdk.nextTurn = { gate: deferred().promise };
  const b = await spawnChild(run.runId, run.rootAgentId, {
    spec: spec("worker-perf"),
    prompt: "profile the hot paths",
  });
  return { ...run, a, b };
}

describe("steer with scope: subtree", () => {
  test("a running parent gets one message — the steer plus its children — and the children get nothing", async () => {
    const gate = deferred();
    const f = await family({ gate: gate.promise });
    await until(() => getAgentRow(f.rootAgentId)?.state === "running", "parent running");

    const res = await call("POST", `/agents/${f.rootAgentId}/steer`, {
      message: "Security review is the priority now; drop performance.",
      scope: "subtree",
    });
    expect(res.status).toBe(200);
    expect(res.body.deliveredAs).toBe("steer");
    expect(res.body.roster.map((r: { agentId: string }) => r.agentId)).toEqual([
      f.a.agentId,
      f.b.agentId,
    ]);

    expect(f.root.steered).toHaveLength(1);
    const envelope = f.root.steered[0]!;
    expect(envelope).toContain("Security review is the priority now");
    for (const child of [f.a, f.b]) {
      expect(envelope).toContain(child.agentId);
      expect(envelope).toContain(child.agent.sandboxId);
      expect(child.agent.steered).toEqual([]);
    }
    expect(envelope).toContain("review the auth module");
    expect(envelope).toContain("alineo steer <sandboxId>");

    expect(
      events(f.runId).find((e) => e.event === "agent.steered" && e.agentId === f.rootAgentId),
    ).toMatchObject({ scope: "subtree", roster: [f.a.agentId, f.b.agentId], deliveredAs: "steer" });
    gate.resolve();
  });

  test("an idle parent gets the message as a new turn", async () => {
    const f = await family();
    await until(() => getAgentRow(f.rootAgentId)?.state === "done", "parent idle");

    const res = await call("POST", `/agents/${f.rootAgentId}/steer`, {
      message: "Wrap up and summarise.",
      scope: "subtree",
    });
    expect(res.body.deliveredAs).toBe("turn");
    await until(() => f.root.prompts.length === 2, "the steer turn");
    expect(f.root.prompts[1]).toContain("Wrap up and summarise.");
    expect(f.root.prompts[1]).toContain(f.a.agentId);
  });

  test("a paused parent gets it on resume", async () => {
    const gate = deferred();
    const f = await family({ gate: gate.promise });
    await until(() => getAgentRow(f.rootAgentId)?.state === "running", "parent running");
    await call("POST", `/agents/${f.rootAgentId}/pause`);

    const res = await call("POST", `/agents/${f.rootAgentId}/steer`, {
      message: "Change of plan.",
      scope: "subtree",
    });
    expect(res.body.deliveredAs).toBe("queued");
    expect(f.root.steered).toEqual([]);

    await call("POST", `/agents/${f.rootAgentId}/resume`);
    await until(() => f.root.steered.length === 1, "delivered on resume");
    expect(f.root.steered[0]).toContain("Change of plan.");
    gate.resolve();
  });

  test("404 for an unknown agent, 409 when not live", async () => {
    const f = await family();
    expect(
      (await call("POST", "/agents/a_missing/steer", { message: "x", scope: "subtree" })).status,
    ).toBe(404);
    await call("POST", `/agents/${f.a.agentId}/stop`);
    expect(
      (await call("POST", `/agents/${f.a.agentId}/steer`, { message: "x", scope: "subtree" }))
        .status,
    ).toBe(409);
  });
});

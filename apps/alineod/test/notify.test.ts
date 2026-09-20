/** notifyOn + the per-agent inbox (research/tier-1-2-plan.md #5). */
import { afterEach, describe, expect, test } from "bun:test";
import { forget } from "../src/engine/registry";
import { rehydrate } from "../src/engine/rehydrate";
import { getAgentRow } from "../src/state/projection";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

const rootSpec = { spec: spec("root", { spawnDepth: 3 }) };

async function worker(
  runId: string,
  parentId: string,
  name: string,
  turn: { gate?: Promise<void>; text?: string | null } = {},
) {
  fakeSdk.nextTurn = { text: `${name} says hello`, ...turn };
  return spawnChild(runId, parentId, { spec: spec(name), prompt: name });
}

const inbox = async (agentId: string) => (await call("GET", `/agents/${agentId}/inbox`)).body;

describe("notifyOn delivery", () => {
  test("a running subscriber is steered with the notification when the agent it watches finishes", async () => {
    const run = await startRun(rootSpec);
    const subGate = deferred();
    const depGate = deferred();
    const sub = await worker(run.runId, run.rootAgentId, "sub", { gate: subGate.promise });
    const dep = await worker(run.runId, run.rootAgentId, "dep", { gate: depGate.promise });
    await call("POST", `/agents/${sub.agentId}/notify-on`, { agents: [dep.agentId] });

    depGate.resolve();
    await until(() => sub.agent.steered.length === 1, "subscriber steered");
    expect(sub.agent.steered[0]).toContain(dep.agentId);
    expect(sub.agent.steered[0]).toContain("finished: success");
    expect(sub.agent.steered[0]).toContain("dep says hello");
    expect((await inbox(sub.agentId)).delivered[0]).toMatchObject({ deliveredAs: "steer" });
    subGate.resolve();
  });

  test("a paused subscriber gets everything that arrived, in one message, on resume", async () => {
    const run = await startRun(rootSpec);
    const subGate = deferred();
    const sub = await worker(run.runId, run.rootAgentId, "sub", { gate: subGate.promise });
    const a = await worker(run.runId, run.rootAgentId, "a", { gate: deferred().promise });
    const b = await worker(run.runId, run.rootAgentId, "b", { gate: deferred().promise });
    await call("POST", `/agents/${sub.agentId}/notify-on`, { agents: [a.agentId, b.agentId] });
    await call("POST", `/agents/${sub.agentId}/pause`);

    await call("POST", `/agents/${a.agentId}/stop`);
    await call("POST", `/agents/${b.agentId}/stop`);
    await until(async () => (await inbox(sub.agentId)).pending.length === 2, "two queued");
    expect(sub.agent.steered).toEqual([]);

    await call("POST", `/agents/${sub.agentId}/resume`);
    await until(() => sub.agent.steered.length === 1, "one merged steer");
    expect(sub.agent.steered[0]).toContain(a.agentId);
    expect(sub.agent.steered[0]).toContain(b.agentId);
    expect(sub.agent.steered[0]).toContain("finished: aborted");
    subGate.resolve();
  });

  test("an idle subscriber gets it prepended to its next prompt; with wake it gets a new turn", async () => {
    const run = await startRun(rootSpec);
    const idle = await worker(run.runId, run.rootAgentId, "idle");
    await until(() => getAgentRow(idle.agentId)?.state === "done", "idle to finish");
    const depGate = deferred();
    const dep = await worker(run.runId, run.rootAgentId, "dep", { gate: depGate.promise });
    await call("POST", `/agents/${idle.agentId}/notify-on`, { agents: [dep.agentId] });
    depGate.resolve();
    await until(async () => (await inbox(idle.agentId)).pending.length === 1, "queued while idle");

    await call("POST", `/agents/${idle.agentId}/prompt`, { text: "carry on" });
    await until(() => idle.agent.prompts.length === 2, "the next prompt");
    expect(idle.agent.prompts[1]).toContain(dep.agentId);
    expect(idle.agent.prompts[1]?.endsWith("carry on")).toBe(true);
    expect((await inbox(idle.agentId)).delivered[0]).toMatchObject({ deliveredAs: "prompt" });

    const waker = await worker(run.runId, run.rootAgentId, "waker");
    await until(() => getAgentRow(waker.agentId)?.state === "done", "waker idle");
    const late = await worker(run.runId, run.rootAgentId, "late", { gate: deferred().promise });
    await call("POST", `/agents/${waker.agentId}/notify-on`, {
      agents: [late.agentId],
      wake: true,
    });
    await call("POST", `/agents/${late.agentId}/stop`);
    await until(() => waker.agent.prompts.length === 2, "a woken turn");
    expect(waker.agent.prompts[1]).toContain(late.agentId);
  });

  test("POST /agents/:id/inbox/deliver wakes an idle subscriber on demand", async () => {
    const run = await startRun(rootSpec);
    const idle = await worker(run.runId, run.rootAgentId, "idle");
    await until(() => getAgentRow(idle.agentId)?.state === "done", "idle to finish");
    const dep = await worker(run.runId, run.rootAgentId, "dep");
    await until(() => getAgentRow(dep.agentId)?.state === "done", "dep done");
    // Subscribing to an agent that already finished notifies at once.
    await call("POST", `/agents/${idle.agentId}/notify-on`, { agents: [dep.agentId] });
    expect((await inbox(idle.agentId)).pending).toHaveLength(1);

    const res = await call("POST", `/agents/${idle.agentId}/inbox/deliver`);
    expect(res.body.delivery).toBe("turn");
    await until(() => idle.agent.prompts.length === 2, "the delivered turn");
  });

  test("a re-prompted agent that finishes again notifies again, marked as such", async () => {
    const run = await startRun(rootSpec);
    const subGate = deferred();
    const sub = await worker(run.runId, run.rootAgentId, "sub", { gate: subGate.promise });
    const dep = await worker(run.runId, run.rootAgentId, "dep");
    await until(() => getAgentRow(dep.agentId)?.state === "done", "dep done");
    await call("POST", `/agents/${sub.agentId}/notify-on`, { agents: [dep.agentId] });
    await until(() => sub.agent.steered.length === 1, "first notification");

    await call("POST", `/agents/${dep.agentId}/prompt`, { text: "once more" });
    await until(() => sub.agent.steered.length === 2, "second notification");
    expect(sub.agent.steered[1]).toContain("finished again");
    subGate.resolve();
  });

  test("notifyOn at spawn subscribes the child", async () => {
    const run = await startRun(rootSpec);
    const depGate = deferred();
    const dep = await worker(run.runId, run.rootAgentId, "dep", { gate: depGate.promise });
    fakeSdk.nextTurn = { gate: deferred().promise };
    const child = await spawnChild(run.runId, run.rootAgentId, {
      spec: spec("watcher"),
      prompt: "watch",
      notifyOn: [dep.agentId],
    });
    await until(() => getAgentRow(child.agentId)?.state === "running", "watcher running");
    depGate.resolve();
    await until(() => child.agent.steered.length === 1, "watcher notified");
  });

  test("a closed subscriber's notifications are dropped; a failed steer stays pending", async () => {
    const run = await startRun(rootSpec);
    const closed = await worker(run.runId, run.rootAgentId, "closed", { gate: deferred().promise });
    const flaky = await worker(run.runId, run.rootAgentId, "flaky", { gate: deferred().promise });
    const depGate = deferred();
    const dep = await worker(run.runId, run.rootAgentId, "dep", { gate: depGate.promise });
    await call("POST", `/agents/${closed.agentId}/notify-on`, { agents: [dep.agentId] });
    await call("POST", `/agents/${flaky.agentId}/notify-on`, { agents: [dep.agentId] });
    await call("POST", `/agents/${closed.agentId}/stop`);
    flaky.agent.steerError = new Error("bridge busy");

    depGate.resolve();
    await until(async () => (await inbox(closed.agentId)).delivered.length === 1, "dropped");
    expect((await inbox(closed.agentId)).delivered[0]).toMatchObject({
      state: "dropped",
      deliveredAs: "recipient-closed",
    });
    await until(async () => (await inbox(flaky.agentId)).pending.length === 1, "flaky pending");

    flaky.agent.steerError = undefined;
    expect((await call("POST", `/agents/${flaky.agentId}/inbox/deliver`)).body.delivery).toBe(
      "steer",
    );
    expect(flaky.agent.steered).toHaveLength(1);
  });

  test("a pending notification survives a restart and is delivered on resume", async () => {
    const run = await startRun(rootSpec);
    const sub = await worker(run.runId, run.rootAgentId, "sub", { gate: deferred().promise });
    const depGate = deferred();
    const dep = await worker(run.runId, run.rootAgentId, "dep", { gate: depGate.promise });
    await call("POST", `/agents/${sub.agentId}/notify-on`, { agents: [dep.agentId] });
    await call("POST", `/agents/${sub.agentId}/pause`);
    depGate.resolve();
    await until(async () => (await inbox(sub.agentId)).pending.length === 1, "queued");

    for (const id of [run.rootAgentId, sub.agentId, dep.agentId]) forget(id);
    await rehydrate();
    expect((await inbox(sub.agentId)).pending).toHaveLength(1);

    await call("POST", `/agents/${sub.agentId}/resume`);
    await until(() => sub.agent.steered.length === 1, "delivered after the restart");
  });

  test("validation: unknown agents and self-subscription are 400", async () => {
    const run = await startRun(rootSpec);
    const a = await worker(run.runId, run.rootAgentId, "a");
    expect(
      (await call("POST", `/agents/${a.agentId}/notify-on`, { agents: ["a_nope"] })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/agents/${a.agentId}/notify-on`, { agents: [a.agentId] })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/runs/${run.runId}/agents`, {
          parentAgentId: run.rootAgentId,
          spec: spec("x"),
          notifyOn: ["a_nope"],
        })
      ).status,
    ).toBe(400);
    expect(events(run.runId).some((e) => e.event === "agent_spawned" && e.specName === "x")).toBe(
      false,
    );
  });
});

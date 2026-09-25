/** Live intervention: prompt, steer, pause/resume, stop, and GET /agents/:id. */
import { afterEach, describe, expect, test } from "bun:test";
import { emit } from "../src/engine/emit";
import { newAgentId } from "../src/ids";
import { call, deferred, events, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

/** An agent that exists in the run but has no live connection (e.g. still held by waitFor). */
function notLiveAgent(runId: string): string {
  const id = newAgentId();
  emit(runId, id, "agent.spawned", {
    parentAgentId: null,
    runId,
    specName: "held",
    specJson: JSON.stringify(spec("held")),
    depth: 1,
    spawnIndex: 0,
    sandboxId: null,
  });
  return id;
}

describe("POST /agents/:id/steer", () => {
  test("delivers the message to the agent and records agent_steered", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { runId, rootAgentId, root } = await startRun({ prompt: "write an essay" });

    const res = await call("POST", `/agents/${rootAgentId}/steer`, {
      message: "three bullets instead",
    });
    expect(res.status).toBe(202);
    expect(root.steered).toEqual(["three bullets instead"]);
    expect(events(runId).filter((e) => e.event === "agent.steered")).toEqual([
      expect.objectContaining({ agentId: rootAgentId, message: "three bullets instead" }),
    ]);
    gate.resolve();
  });

  test("404 for an unknown agent", async () => {
    expect((await call("POST", "/agents/a_missing/steer", { message: "x" })).status).toBe(404);
  });

  test("409 for an agent that isn't live", async () => {
    const { runId } = await startRun();
    const res = await call("POST", `/agents/${notLiveAgent(runId)}/steer`, { message: "x" });
    expect(res.status).toBe(409);
  });

  test("502 when the harness rejects the message, and nothing is recorded", async () => {
    const { runId, rootAgentId, root } = await startRun();
    root.steerError = new Error("bridge returned 500");
    const res = await call("POST", `/agents/${rootAgentId}/steer`, { message: "x" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("bridge returned 500");
    expect(events(runId).some((e) => e.event === "agent.steered")).toBe(false);
  });

  test("400 for an empty message", async () => {
    const { rootAgentId } = await startRun();
    expect((await call("POST", `/agents/${rootAgentId}/steer`, { message: "" })).status).toBe(400);
  });
});

describe("POST /agents/:id/pause and /resume", () => {
  test("pause freezes the sandbox, resume thaws it, each recorded as an operator transition", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { runId, rootAgentId, root } = await startRun({ prompt: "work" });
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "running");

    expect((await call("POST", `/agents/${rootAgentId}/pause`)).status).toBe(202);
    expect(root.paused).toBe(true);
    expect((await call("GET", `/agents/${rootAgentId}`)).body.state).toBe("paused");

    expect((await call("POST", `/agents/${rootAgentId}/resume`)).status).toBe(202);
    expect(root.paused).toBe(false);
    expect((await call("GET", `/agents/${rootAgentId}`)).body.state).toBe("running");

    const transitions = events(runId).filter(
      (e) => e.event === "agent.state_changed" && e.reason === "operator",
    );
    expect(transitions.map((e) => [e.from, e.to])).toEqual([
      ["running", "paused"],
      ["paused", "running"],
    ]);
    gate.resolve();
  });

  test("pausing an already-paused agent is a no-op", async () => {
    const { runId, rootAgentId } = await startRun();
    await call("POST", `/agents/${rootAgentId}/pause`);
    const before = events(runId).length;
    expect((await call("POST", `/agents/${rootAgentId}/pause`)).status).toBe(202);
    expect(events(runId).length).toBe(before);
  });

  test("resume on an agent that isn't paused is 409", async () => {
    const { rootAgentId } = await startRun();
    expect((await call("POST", `/agents/${rootAgentId}/resume`)).status).toBe(409);
  });

  test("pause is 404 for an unknown agent, 409 when not live, 502 when the sandbox refuses", async () => {
    const { runId, rootAgentId, root } = await startRun();
    expect((await call("POST", "/agents/a_missing/pause")).status).toBe(404);
    expect((await call("POST", `/agents/${notLiveAgent(runId)}/pause`)).status).toBe(409);

    root.pauseError = new Error("runtime does not support pause");
    const res = await call("POST", `/agents/${rootAgentId}/pause`);
    expect(res.status).toBe(502);
    expect((await call("GET", `/agents/${rootAgentId}`)).body.state).not.toBe("paused");
  });
});

describe("GET /agents/:id", () => {
  test("includes session stats from the harness", async () => {
    const { rootAgentId } = await startRun();
    expect((await call("GET", `/agents/${rootAgentId}`)).body.sessionStats).toEqual({
      totalTokens: 42,
    });
  });

  test("omits session stats while paused, without waiting on the frozen harness", async () => {
    const { rootAgentId, root } = await startRun();
    await call("POST", `/agents/${rootAgentId}/pause`);
    root.hangSessionStats = true;
    const started = Date.now();
    const res = await call("GET", `/agents/${rootAgentId}`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.body.sessionStats).toBeUndefined();
  });

  test("gives up on an unresponsive harness after about two seconds", async () => {
    const { rootAgentId, root } = await startRun();
    root.hangSessionStats = true;
    const started = Date.now();
    const res = await call("GET", `/agents/${rootAgentId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionStats).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);

  test("404 for an unknown agent", async () => {
    expect((await call("GET", "/agents/a_missing")).status).toBe(404);
  });
});

describe("POST /agents/:id/prompt", () => {
  test("starts a new turn on a live agent", async () => {
    const { rootAgentId, root } = await startRun();
    expect(
      (await call("POST", `/agents/${rootAgentId}/prompt`, { text: "next task" })).status,
    ).toBe(202);
    await until(() => root.prompts.includes("next task"));
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");
  });

  test("409 when not live, 400 for empty text", async () => {
    const { runId, rootAgentId } = await startRun();
    expect(
      (await call("POST", `/agents/${notLiveAgent(runId)}/prompt`, { text: "x" })).status,
    ).toBe(409);
    expect((await call("POST", `/agents/${rootAgentId}/prompt`, { text: "" })).status).toBe(400);
  });
});

describe("POST /agents/:id/stop", () => {
  test("aborts, closes, ends the agent as aborted, and releases its handle", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { rootAgentId, root } = await startRun({ prompt: "work" });

    expect((await call("POST", `/agents/${rootAgentId}/stop`)).status).toBe(202);
    expect(root.aborted).toBe(true);
    expect(root.closed).toBe(true);
    expect((await call("GET", `/agents/${rootAgentId}`)).body).toMatchObject({
      state: "aborted",
      outcome: "aborted",
    });
    expect((await call("GET", `/agents/${rootAgentId}/result`)).body).toMatchObject({
      state: "settled",
      outcome: "aborted",
    });
    expect((await call("POST", `/agents/${rootAgentId}/steer`, { message: "x" })).status).toBe(409);
    gate.resolve();
  });

  test("accepts an explicit mode, and 404s for an unknown agent", async () => {
    const { rootAgentId } = await startRun();
    expect((await call("POST", `/agents/${rootAgentId}/stop`, { mode: "drain" })).status).toBe(202);
    expect((await call("POST", "/agents/a_missing/stop")).status).toBe(404);
  });
});

/**
 * A turn that ends because the model API refused the request (overloaded, a 429, a 404 for a model
 * the account can't use) is not a success. Pi ends such a turn normally, with `stopReason: "error"`
 * on its last assistant message, so the stream doesn't throw and only that message says so.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { turnError } from "../src/engine/stream";
import { rehydrate } from "../src/engine/rehydrate";
import { newAgentId, newRunId } from "../src/ids";
import { emit } from "../src/engine/emit";
import { getAgentRow, getHandle } from "../src/state/projection";
import { call, events, spec, until, wipeState } from "./helpers";
import { FakeAgent, fakeSdk, type FakeTurn } from "./fakes";

beforeEach(() => wipeState());
afterEach(() => fakeSdk.reset());

const assistant = (extra: Record<string, unknown> = {}) => ({ role: "assistant", ...extra });
const overloaded = assistant({
  stopReason: "error",
  errorMessage: "Service temporarily overloaded",
});

/** Start a run whose root's first turn is `turn`, and wait for that turn to end. */
async function runOnce(turn: FakeTurn) {
  fakeSdk.nextTurn = turn;
  const res = await call("POST", "/runs", { spec: spec("worker"), prompt: "go" });
  const agentId: string = res.body.rootAgentId;
  await until(() => ["done", "failed"].includes(getAgentRow(agentId)?.state ?? ""), "turn end");
  return { runId: res.body.runId as string, agentId };
}

describe("turnError", () => {
  test("reads the provider's message off a last assistant message that stopped on an error", () => {
    expect(turnError([{ role: "user" }, overloaded])).toBe("Service temporarily overloaded");
  });

  test("a last assistant message with no text still counts, with a generic message", () => {
    expect(turnError([assistant({ stopReason: "error" })])).toBe("the model API returned an error");
  });

  test("only the LAST assistant message counts: an error a retry got past is history", () => {
    expect(turnError([overloaded, assistant({ stopReason: "stop" })])).toBeUndefined();
    expect(
      turnError([overloaded, assistant({ stopReason: "toolUse" }), { role: "toolResult" }]),
    ).toBeUndefined();
  });

  test.each([
    [undefined],
    [null],
    ["nope"],
    [[]],
    [[{ role: "user" }]],
    [[assistant({ stopReason: "stop" })]],
  ])("no error in %j", (messages) => {
    expect(turnError(messages)).toBeUndefined();
  });

  test("an abort is not an upstream error", () => {
    expect(turnError([assistant({ stopReason: "aborted" })])).toBeUndefined();
  });
});

describe("a turn that ends on a model API error", () => {
  test("ends the agent failed with the provider's message, keeping the text before it", async () => {
    const { runId, agentId } = await runOnce({ text: "Run evaluate.", endMessages: [overloaded] });

    expect(getAgentRow(agentId)).toMatchObject({ state: "failed", outcome: "failed" });
    expect(getHandle(agentId)).toMatchObject({ state: "settled", outcome: "failed" });
    expect(getHandle(agentId)?.result_ref).toBe(`fs://${agentId}/result.md`);
    expect(events(runId).find((e) => e.event === "agent.ended")).toMatchObject({
      outcome: "failed",
      error: "Service temporarily overloaded",
    });
    const result = await call("GET", `/agents/${agentId}/result`);
    expect(result.body).toMatchObject({ outcome: "failed", result: "Run evaluate." });
  });

  test("with no text at all, the result is empty and the agent still ends failed", async () => {
    const { agentId } = await runOnce({ text: null, endMessages: [overloaded] });
    expect(getAgentRow(agentId)).toMatchObject({ state: "failed", outcome: "failed" });
    expect(getHandle(agentId)?.result_ref).toBeNull();
  });

  test("a 404 for a model the account can't use ends it failed too", async () => {
    const notFound = assistant({ stopReason: "error", errorMessage: "404 status code (no body)" });
    const { runId, agentId } = await runOnce({ text: "", endMessages: [notFound] });
    expect(getAgentRow(agentId)?.outcome).toBe("failed");
    expect(events(runId).find((e) => e.event === "agent.ended")).toMatchObject({
      error: "404 status code (no body)",
    });
  });

  test("an OpenSandbox-style JSON body in the message is unwrapped", async () => {
    const body = JSON.stringify({ code: "X::GONE", message: "Model not found." });
    const { runId } = await runOnce({
      endMessages: [assistant({ stopReason: "error", errorMessage: body })],
    });
    expect(events(runId).find((e) => e.event === "agent.ended")).toMatchObject({
      error: "Model not found. (X::GONE)",
    });
  });

  test("an error that a retry got past leaves the turn a success", async () => {
    const { agentId } = await runOnce({
      text: "done",
      endMessages: [overloaded, assistant({ stopReason: "stop" })],
    });
    expect(getAgentRow(agentId)).toMatchObject({ state: "done", outcome: "success" });
  });

  test("a normal turn is unchanged", async () => {
    const { agentId } = await runOnce({
      text: "hello",
      endMessages: [assistant({ stopReason: "stop" })],
    });
    expect(getAgentRow(agentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(getHandle(agentId)?.result_ref).toBe(`fs://${agentId}/result.md`);
  });

  test("a waitFor dependent sees the failure, not a success", async () => {
    const worker = await runOnce({ text: "Run evaluate.", endMessages: [overloaded] });
    const run = worker.runId;
    const res = await call("POST", `/runs/${run}/await`, {
      agents: [worker.agentId],
      mode: "all",
      wait: 2,
    });
    // `all` needs every agent to have succeeded, and this one didn't.
    expect(res.body.outcome).not.toBe("satisfied");
  });
});

describe("a turn followed by polling", () => {
  test("ends failed when the bridge's last message is a model API error", async () => {
    const runId = newRunId();
    const sandbox = new FakeAgent({ name: "agent", runId });
    sandbox.streaming = true; // Pi is still mid-turn when alineod comes back
    const id = newAgentId();
    emit(runId, id, "agent.spawned", {
      parentAgentId: null,
      runId,
      specName: "agent",
      specJson: JSON.stringify(spec("agent")),
      depth: 0,
      spawnIndex: 0,
      sandboxId: null,
      spawnBudget: 2,
      maxAgentsBudget: null,
      waitFor: null,
      prompt: null,
    });
    emit(runId, id, "agent.provisioned", { sandboxId: sandbox.sandboxId });
    emit(runId, id, "agent.state_changed", { from: "provisioning", to: "running" });

    await rehydrate();
    sandbox.lastText = "Run evaluate.";
    sandbox.messages = [
      assistant({ stopReason: "error", errorMessage: "429 status code (no body)" }),
    ];
    sandbox.streaming = false;

    await until(() => getHandle(id)?.state === "settled", "catch-up settle", 6_000);
    expect(getAgentRow(id)).toMatchObject({ state: "failed", outcome: "failed" });
    expect(events(runId).find((e) => e.event === "agent.ended")).toMatchObject({
      error: "429 status code (no body)",
    });
  }, 10_000);
});

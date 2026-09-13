/** GET /agents/:id/result — immediate, long-polled, and how turn endings map to results. */
import { afterEach, describe, expect, test } from "bun:test";
import { call, deferred, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

test("202 pending while the turn is running, without wait", async () => {
  const gate = deferred();
  fakeSdk.nextTurn = { gate: gate.promise };
  const { rootAgentId } = await startRun({ prompt: "work" });

  const res = await call("GET", `/agents/${rootAgentId}/result`);
  expect(res).toEqual({
    status: 202,
    body: { agentId: rootAgentId, state: "pending", outcome: null, resultRef: null, result: null },
  });
  gate.resolve();
});

describe("?wait=", () => {
  test("holds the request open and returns the moment the result settles", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, text: "finished" };
    const { rootAgentId } = await startRun({ prompt: "work" });

    const started = Date.now();
    const pending = call("GET", `/agents/${rootAgentId}/result?wait=10`);
    await Bun.sleep(150);
    gate.resolve();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "settled", outcome: "success", result: "finished" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("returns 202 pending once the wait elapses", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { rootAgentId } = await startRun({ prompt: "work" });

    const started = Date.now();
    const res = await call("GET", `/agents/${rootAgentId}/result?wait=1`);
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    gate.resolve();
  }, 5_000);

  test("returns immediately when the result has already settled", async () => {
    const { rootAgentId } = await startRun({ prompt: "quick" });
    await until(async () => (await call("GET", `/agents/${rootAgentId}/result`)).status === 200);
    const started = Date.now();
    expect((await call("GET", `/agents/${rootAgentId}/result?wait=30`)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("turn endings", () => {
  test("a turn that fails with partial output still settles as success with that text", async () => {
    fakeSdk.nextTurn = { text: "half an answer", error: "stream stalled" };
    const { rootAgentId } = await startRun({ prompt: "work" });

    const res = await until(async () => {
      const r = await call("GET", `/agents/${rootAgentId}/result`);
      return r.status === 200 ? r : null;
    });
    expect(res.body).toMatchObject({
      outcome: "success",
      resultRef: `fs://${rootAgentId}/result.md`,
      result: "half an answer",
    });
  });

  test("a turn that fails with no output settles as failed with no resultRef", async () => {
    fakeSdk.nextTurn = { text: null, error: "provider 401" };
    const { rootAgentId } = await startRun({ prompt: "work" });

    const res = await until(async () => {
      const r = await call("GET", `/agents/${rootAgentId}/result`);
      return r.status === 200 ? r : null;
    });
    expect(res.body).toMatchObject({ outcome: "failed", resultRef: null });
    expect((await call("GET", `/agents/${rootAgentId}`)).body).toMatchObject({
      state: "failed",
      outcome: "failed",
    });
  });
});

test("404 for an unknown agent", async () => {
  expect((await call("GET", "/agents/a_missing/result")).status).toBe(404);
});

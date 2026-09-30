/**
 * `idempotencyKey` on pause/resume/stop/steer (command_idempotency, generalizing spawn's
 * spawn_idempotency — see spawn.test.ts's own "idempotencyKey" describe block).
 *
 * The interesting case is NOT "a retried pause on an already-paused agent is a no-op" — that's
 * already true with no key at all, from each command's own state-transition idempotence
 * (pause-safety.test.ts). What only the idempotency table adds is: (a) a retried request after a
 * FAILURE replays the same failure without re-attempting the side effect, and (b) `steer`, which
 * has no state-transition idempotence of its own (it's a fire-once delivery, not a no-op check),
 * doesn't deliver a retried message twice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getAgentRow } from "../src/state/projection";
import { call, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

describe("pause/resume idempotencyKey", () => {
  test("a retried pause that failed the first time replays the same failure, without pausing again", async () => {
    const { rootAgentId, root: agent } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");
    agent.pauseError = new Error("sandbox unreachable");

    const first = await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "k1" });
    expect(first.status).toBe(502);
    expect(agent.pauseCallCount).toBe(1);

    const retry = await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "k1" });
    expect(retry.status).toBe(502);
    expect(retry.body).toEqual(first.body);
    // The whole point: the retry did NOT call sandbox.pause() again.
    expect(agent.pauseCallCount).toBe(1);
  });

  test("a retried pause after success replays without re-pausing the sandbox", async () => {
    const { rootAgentId, root: agent } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    const first = await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "k2" });
    expect(first.status).toBe(202);
    expect(agent.pauseCallCount).toBe(1);

    const retry = await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "k2" });
    expect(retry.status).toBe(202);
    expect(agent.pauseCallCount).toBe(1);
    expect(getAgentRow(rootAgentId)?.state).toBe("paused");
  });

  test("a fresh key is not affected by another key's cached result", async () => {
    const { rootAgentId, root: agent } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "a" });
    await call("POST", `/agents/${rootAgentId}/resume`, { idempotencyKey: "b" });
    const third = await call("POST", `/agents/${rootAgentId}/pause`, { idempotencyKey: "c" });

    expect(third.status).toBe(202);
    expect(agent.pauseCallCount).toBe(2); // "a" and "c" each really paused; "b" only resumed
    expect(getAgentRow(rootAgentId)?.state).toBe("paused");
  });
});

describe("steer idempotencyKey", () => {
  test("a retried steer with the same key is delivered once, not twice", async () => {
    const { rootAgentId, root: agent } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    const first = await call("POST", `/agents/${rootAgentId}/steer`, {
      message: "look at the auth module",
      idempotencyKey: "steer-1",
    });
    expect(first.status).toBe(202);

    const retry = await call("POST", `/agents/${rootAgentId}/steer`, {
      message: "look at the auth module",
      idempotencyKey: "steer-1",
    });
    expect(retry.status).toBe(202);

    expect(agent.steered).toEqual(["look at the auth module"]);
  });

  test("two different steer calls sharing no key are both delivered", async () => {
    const { rootAgentId, root: agent } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    await call("POST", `/agents/${rootAgentId}/steer`, { message: "first" });
    await call("POST", `/agents/${rootAgentId}/steer`, { message: "second" });

    expect(agent.steered).toEqual(["first", "second"]);
  });
});

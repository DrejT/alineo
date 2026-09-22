/**
 * Pausing must never break the swarm it pauses (research/subtree-controls-fixes.md):
 *
 * - G3: checking a turn's state never hangs on a frozen or dead bridge.
 * - B1/B2: a stream timeout (including one that fires during a pause) hands the turn to
 *   catch-up instead of settling it with a cut-off result.
 * - B4: a spawn under a paused parent waits for the resume instead of failing.
 * - Resume restores the state the agent had before the pause.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isCatchingUp, probeTurn } from "../src/engine/stream";
import { getAgentRow, getHandle } from "../src/state/projection";
import { call, deferred, events, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

const root = { spec: spec("root", { spawnDepth: 2 }) };

describe("probeTurn", () => {
  test("reports a paused agent without asking its frozen bridge", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { rootAgentId } = await startRun({ prompt: "work" });
    await until(() => getAgentRow(rootAgentId)?.state === "running");
    await call("POST", `/agents/${rootAgentId}/pause`);

    const started = Date.now();
    expect(await probeTurn(rootAgentId)).toBe("paused");
    expect(Date.now() - started).toBeLessThan(50);

    await call("POST", `/agents/${rootAgentId}/resume`);
    gate.resolve();
  });

  test("reports an unresponsive bridge as unreachable after the probe timeout", async () => {
    const { rootAgentId, root: agent } = await startRun();
    agent.hangState = true;
    expect(await probeTurn(rootAgentId)).toBe("unreachable");
  });

  test("reports a stopped agent as gone", async () => {
    const { rootAgentId } = await startRun();
    await call("POST", `/agents/${rootAgentId}/stop`);
    expect(await probeTurn(rootAgentId)).toBe("gone");
  });
});

describe("stream timeouts", () => {
  test("hand the turn to catch-up, which records the full answer once Pi finishes", async () => {
    fakeSdk.nextTurn = { detach: true };
    const { runId, rootAgentId, root: agent } = await startRun({ prompt: "long task" });

    await until(() => isCatchingUp(rootAgentId), "catch-up to start");
    expect(getHandle(rootAgentId)?.state).toBe("pending");
    expect(getAgentRow(rootAgentId)?.state).toBe("running");
    expect(events(runId).some((e) => e.event === "agent.ended")).toBe(false);

    agent.lastText = "the full answer";
    agent.streaming = false;

    await until(() => getHandle(rootAgentId)?.state === "settled", "settle");
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    expect((await call("GET", `/agents/${rootAgentId}/result`)).body.result).toBe(
      "the full answer",
    );
  });

  test("a new prompt is refused while the previous turn is still being caught up", async () => {
    fakeSdk.nextTurn = { detach: true };
    const { rootAgentId, root: agent } = await startRun({ prompt: "long task" });
    await until(() => isCatchingUp(rootAgentId), "catch-up to start");

    const res = await call("POST", `/agents/${rootAgentId}/prompt`, { text: "more" });
    expect(res.status).toBe(409);
    expect(agent.prompts).toEqual(["long task"]);

    agent.streaming = false;
    await until(() => !isCatchingUp(rootAgentId), "catch-up to finish");
    expect((await call("POST", `/agents/${rootAgentId}/prompt`, { text: "more" })).status).toBe(
      202,
    );
  });

  test("a pause longer than the turn limit doesn't end the turn", async () => {
    fakeSdk.nextTurn = { detach: true };
    const { rootAgentId, root: agent } = await startRun({ prompt: "long task" });
    await until(() => isCatchingUp(rootAgentId), "catch-up to start");

    await call("POST", `/agents/${rootAgentId}/pause`);
    await Bun.sleep(2_500); // longer than ALINEOD_TURN_MAX_MS (2000) in test setup
    expect(getHandle(rootAgentId)?.state).toBe("pending");
    expect(isCatchingUp(rootAgentId)).toBe(true);

    expect((await call("POST", `/agents/${rootAgentId}/resume`)).status).toBe(202);
    agent.lastText = "finished after the pause";
    agent.streaming = false;

    await until(() => getHandle(rootAgentId)?.state === "settled", "settle");
    expect(getHandle(rootAgentId)).toMatchObject({ outcome: "success" });
  }, 10_000);

  test("a turn still running past the limit is settled with its partial text", async () => {
    fakeSdk.nextTurn = { detach: true };
    const { runId, rootAgentId, root: agent } = await startRun({ prompt: "never ends" });
    agent.lastText = "partial";

    await until(() => getHandle(rootAgentId)?.state === "settled", "give up", 6_000);
    expect(getHandle(rootAgentId)).toMatchObject({ outcome: "success" });
    const ended = events(runId).find((e) => e.event === "agent.ended");
    expect(ended?.error).toContain("still running");
  }, 10_000);

  test("stopping the agent during catch-up leaves it aborted", async () => {
    fakeSdk.nextTurn = { detach: true };
    const { runId, rootAgentId, root: agent } = await startRun({ prompt: "long task" });
    await until(() => isCatchingUp(rootAgentId), "catch-up to start");

    await call("POST", `/agents/${rootAgentId}/stop`);
    agent.lastText = "too late";
    agent.streaming = false;

    await until(() => !isCatchingUp(rootAgentId), "catch-up to exit");
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "aborted", outcome: "aborted" });
    expect(events(runId).filter((e) => e.event === "agent.ended")).toHaveLength(1);
  });
});

describe("resume", () => {
  test("restores the state the agent had before the pause", async () => {
    const { runId, rootAgentId } = await startRun({ prompt: "quick" });
    await until(() => getAgentRow(rootAgentId)?.state === "done", "turn to finish");

    await call("POST", `/agents/${rootAgentId}/pause`);
    expect((await call("POST", `/agents/${rootAgentId}/resume`)).status).toBe(202);

    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    await Bun.sleep(100);
    expect(events(runId).filter((e) => e.event === "agent.ended")).toHaveLength(1);
  });
});

describe("spawning under a paused parent", () => {
  test("the child waits for the resume, then forks and runs its prompt", async () => {
    const { runId, rootAgentId, root: parent } = await startRun(root);
    await call("POST", `/agents/${rootAgentId}/pause`);

    const res = await call("POST", `/runs/${runId}/agents`, {
      parentAgentId: rootAgentId,
      spec: spec("child"),
      prompt: "go",
    });
    expect(res.status).toBe(202);
    const childId = res.body.agentId as string;

    await until(() => getAgentRow(childId)?.state === "spawning", "child to hold");
    await Bun.sleep(100);
    expect(parent.spawns).toHaveLength(0);
    expect(getAgentRow(childId)?.outcome).toBeNull();

    await call("POST", `/agents/${rootAgentId}/resume`);
    await until(() => parent.spawns.length === 1, "fork after resume");
    const child = parent.spawns[0]!.child;
    await until(() => child.prompts.includes("go"), "child prompt");

    const reasons = events(runId)
      .filter((e) => e.event === "agent.state_changed" && e.agentId === childId)
      .map((e) => e.reason);
    expect(reasons).toEqual(["parent-paused", "parent-resumed", "prompt"]);
  });

  test("a pause that lands while the fork is in flight is retried after resume, forking once", async () => {
    const { runId, rootAgentId, root: parent } = await startRun(root);
    const gate = deferred();
    parent.forkGate = gate.promise;

    const res = await call("POST", `/runs/${runId}/agents`, {
      parentAgentId: rootAgentId,
      spec: spec("child"),
    });
    const childId = res.body.agentId as string;
    await Bun.sleep(50); // the fork is now waiting on the gate

    await call("POST", `/agents/${rootAgentId}/pause`);
    gate.resolve(); // the in-flight fork is refused: the parent is paused
    await until(() => getAgentRow(childId)?.state === "spawning", "child to hold");
    expect(parent.spawns).toHaveLength(0);

    parent.forkGate = undefined;
    await call("POST", `/agents/${rootAgentId}/resume`);
    await until(() => getAgentRow(childId)?.sandbox_id, "child to fork");
    await Bun.sleep(100);
    expect(parent.spawns).toHaveLength(1);
    expect(getAgentRow(childId)?.outcome).toBeNull();
  });

  test("a held child fails if its parent is stopped instead of resumed", async () => {
    const { runId, rootAgentId } = await startRun(root);
    await call("POST", `/agents/${rootAgentId}/pause`);

    const res = await call("POST", `/runs/${runId}/agents`, {
      parentAgentId: rootAgentId,
      spec: spec("child"),
    });
    const childId = res.body.agentId as string;
    await until(() => getAgentRow(childId)?.state === "spawning", "child to hold");

    await call("POST", `/agents/${rootAgentId}/stop`);
    await until(() => getAgentRow(childId)?.outcome, "child to end");
    expect(getAgentRow(childId)).toMatchObject({ state: "failed", outcome: "failed" });
    expect(
      events(runId).find((e) => e.event === "agent.ended" && e.agentId === childId)?.error,
    ).toContain("no longer live");
  });
});

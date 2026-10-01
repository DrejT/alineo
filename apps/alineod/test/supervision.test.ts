/**
 * Failure policy (agent-supervision.md): onFailure ask/retry/fail, the cross-turn circuit
 * breaker, handle-hold-through-retry, resolving a blocked agent via the existing prompt/stop
 * routes (no new route), and the automatic (non-opt-in) parent notification.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getAgentRow, getHandle, inboxOf } from "../src/state/projection";
import { getSupervisionCounters } from "../src/state/db";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

async function endedView(agentId: string) {
  return until(async () => {
    const r = await call("GET", `/agents/${agentId}`);
    return r.body.outcome ? r.body : null;
  }, `${agentId} to end`);
}

describe("onFailure default (fail) — unchanged behavior for every pre-existing spec", () => {
  test("a spec with no onFailure still settles failed immediately, no hold", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const { rootAgentId } = await startRun({ prompt: "go" });
    expect(await endedView(rootAgentId)).toMatchObject({ state: "failed", outcome: "failed" });
  });
});

describe("onFailure: ask", () => {
  test("holds the agent blocked instead of settling, and notifies via agent.supervision_needed", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const { runId, rootAgentId } = await startRun({
      spec: spec("root", { onFailure: "ask" }),
      prompt: "go",
    });

    await until(() => getAgentRow(rootAgentId)?.state === "blocked", "agent to block");
    expect(getHandle(rootAgentId)?.state).toBe("pending"); // NOT settled
    expect(getAgentRow(rootAgentId)?.ended_at).toBeNull(); // NOT ended

    const needed = events(runId).find((e) => e.event === "agent.supervision_needed");
    expect(needed).toMatchObject({ reason: "ask", error: "boom" });
  });

  test("resolving by prompting retries, and a success settles the handle", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const { rootAgentId, root: agent } = await startRun({
      spec: spec("root", { onFailure: "ask" }),
      prompt: "go",
    });
    await until(() => getAgentRow(rootAgentId)?.state === "blocked", "agent to block");

    agent.turn = { text: "finished on retry" };
    expect(
      (await call("POST", `/agents/${rootAgentId}/prompt`, { text: "try again" })).status,
    ).toBe(202);

    await until(() => getHandle(rootAgentId)?.state === "settled", "settle after retry");
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(getSupervisionCounters(rootAgentId).consecutiveFailures).toBe(0); // reset on success
  });

  test("resolving by stopping settles it aborted — no new route needed", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const { rootAgentId } = await startRun({
      spec: spec("root", { onFailure: "ask" }),
      prompt: "go",
    });
    await until(() => getAgentRow(rootAgentId)?.state === "blocked", "agent to block");

    expect((await call("POST", `/agents/${rootAgentId}/stop`)).status).toBe(202);
    expect(await endedView(rootAgentId)).toMatchObject({ outcome: "aborted" });
  });
});

describe("onFailure: retry", () => {
  test("automatically re-prompts up to maxRetries, then blocks with retries-exhausted", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const {
      runId,
      rootAgentId,
      root: agent,
    } = await startRun({
      spec: spec("root", { onFailure: "retry", maxRetries: 2, maxConsecutiveFailures: 10 }),
      prompt: "go",
    });

    await until(() => getAgentRow(rootAgentId)?.state === "blocked", "agent to give up", 6_000);
    expect(agent.prompts.length).toBe(3); // original + 2 automatic retries
    expect(getHandle(rootAgentId)?.state).toBe("pending"); // never settled through all 3 attempts
    expect(events(runId).filter((e) => e.event === "agent.turn_failed")).toHaveLength(3);
    expect(events(runId).find((e) => e.event === "agent.supervision_needed")).toMatchObject({
      reason: "retries-exhausted",
    });
  }, 10_000);

  test("a success partway through resets the retry count", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, text: null, error: "boom" };
    const { rootAgentId, root: agent } = await startRun({
      spec: spec("root", { onFailure: "retry", maxRetries: 3, maxConsecutiveFailures: 10 }),
      prompt: "go",
    });
    // Gated, so the first attempt can't resolve (and the retry it triggers can't fire) before
    // this fixes what the NEXT attempt sees — the fake's retries otherwise resolve fast enough
    // that polling for an exact prompts.length can miss the window entirely.
    await until(() => agent.prompts.includes("go"), "first attempt reaches the gate");
    gate.resolve();
    agent.turn = { text: "recovered" };

    await until(() => getHandle(rootAgentId)?.state === "settled", "settles on the auto-retry");
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    expect(getSupervisionCounters(rootAgentId)).toEqual({
      turnRetryCount: 0,
      consecutiveFailures: 0,
    });
  });
});

describe("circuit breaker — overrides onFailure regardless of remaining budget", () => {
  test("trips before a generous retry budget is exhausted", async () => {
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const {
      runId,
      rootAgentId,
      root: agent,
    } = await startRun({
      spec: spec("root", { onFailure: "retry", maxRetries: 10, maxConsecutiveFailures: 2 }),
      prompt: "go",
    });

    await until(() => getAgentRow(rootAgentId)?.state === "blocked", "circuit to trip", 6_000);
    expect(agent.prompts.length).toBe(2); // tripped at 2, nowhere near the budget of 10
    expect(events(runId).find((e) => e.event === "agent.supervision_needed")).toMatchObject({
      reason: "circuit-tripped",
    });
  }, 10_000);
});

describe("handle-hold-through-retry — an awaiter never sees a premature failure", () => {
  test("a waitFor dependent stays held while the dependency is still retrying, then proceeds", async () => {
    const root = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, text: null, error: "boom" };
    const dep = await spawnChild(root.runId, root.rootAgentId, {
      spec: spec("dep", { onFailure: "retry", maxRetries: 2, maxConsecutiveFailures: 10 }),
      prompt: "work",
    });
    await until(() => dep.agent.prompts.includes("work"), "dep's first attempt reaches the gate");

    const res = await call("POST", `/runs/${root.runId}/agents`, {
      parentAgentId: root.rootAgentId,
      spec: spec("gather"),
      waitFor: [dep.agentId],
      prompt: "combine",
    });
    const gatherId = res.body.agentId as string;
    await Bun.sleep(50);
    // The dependency is still gated mid-attempt — the gather must NOT have forked.
    expect(getAgentRow(gatherId)?.state).toBe("spawning");
    expect(root.root.spawns.find((s) => s.child.name === "gather")).toBeUndefined();

    gate.resolve();
    dep.agent.turn = { text: "done on retry" };
    await until(
      () => root.root.spawns.find((s) => s.child.name === "gather") !== undefined,
      "gather forks once the dependency actually settles",
      6_000,
    );
  }, 10_000);
});

describe("automatic parent notification — not opt-in via notifyOn", () => {
  test("a blocked child's parent gets a supervision inbox entry with no subscription set up", async () => {
    const root = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    fakeSdk.nextTurn = { text: null, error: "boom" };
    const child = await spawnChild(root.runId, root.rootAgentId, {
      spec: spec("child", { onFailure: "ask" }),
      prompt: "work",
    });

    await until(() => getAgentRow(child.agentId)?.state === "blocked", "child to block");
    const inbox = await until(
      () => inboxOf(root.rootAgentId).find((i) => i.kind === "supervision") ?? null,
      "parent inbox to receive the supervision notice",
    );
    expect(inbox).toMatchObject({ about_agent_id: child.agentId, outcome: "ask" });
  });
});

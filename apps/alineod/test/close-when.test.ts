/**
 * plans/07-10-2026/close-when.md: a run created with `closeWhen: "quiescent"` closes itself
 * the moment its subtree goes quiescent, with no client call — and a pending inbox entry on an
 * otherwise-terminal member must block that, same as a paused member already does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { emit } from "../src/engine/emit";
import { getRun, rebuild } from "../src/state/projection";
import { newAgentId, newRunId } from "../src/ids";
import { call, deferred, events, spec, spawnChild, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

describe("apply() folds run.started / run.closed", () => {
  test("run.started creates an open row with the given closeWhen", () => {
    const runId = newRunId();
    emit(runId, null, "run.started", { runId, closeWhen: "quiescent" });
    expect(getRun(runId)).toMatchObject({
      run_id: runId,
      close_when: "quiescent",
      state: "open",
      closed_at: null,
    });
  });

  test("an old-shaped run.started row (no closeWhen) defaults to explicit on replay", () => {
    const runId = newRunId();
    // emit() never validates against the Zod schema at write time (packages/schema's
    // `.default()` only applies when something parses the payload) — this is exactly the
    // shape a row written before this field existed actually has.
    emit(runId, null, "run.started", { runId });
    expect(getRun(runId)).toMatchObject({ close_when: "explicit", state: "open" });
  });

  test("run.closed flips the row to closed exactly once", () => {
    const runId = newRunId();
    emit(runId, null, "run.started", { runId, closeWhen: "quiescent" });
    emit(runId, null, "run.closed", { reason: "quiescent" });
    const row = getRun(runId)!;
    expect(row.state).toBe("closed");
    expect(row.closed_at).not.toBeNull();

    // A second fold (replay, or a stray duplicate) must not move closed_at again.
    const closedAt = row.closed_at;
    emit(runId, null, "run.closed", { reason: "quiescent" });
    expect(getRun(runId)!.closed_at).toBe(closedAt);
  });

  test("rebuild() refolds a closed run to the same row", () => {
    const runId = newRunId();
    emit(runId, newAgentId(), "run.started", { runId, closeWhen: "quiescent" });
    emit(runId, null, "run.closed", { reason: "quiescent" });
    const before = getRun(runId);
    rebuild();
    expect(getRun(runId)).toEqual(before);
  });
});

describe("closeWhen: quiescent auto-closes the run", () => {
  test("a single-agent run closes itself the moment its one turn finishes", async () => {
    const { runId, rootAgentId } = await startRun({ prompt: "say hi", closeWhen: "quiescent" });
    await until(async () => (await call("GET", `/runs/${runId}`)).body.state === "closed");

    expect(events(runId).map((e) => e.event)).toContain("run.closed");
    expect(events(runId).find((e) => e.event === "run.closed")?.reason).toBe("quiescent");

    // Closed means released: spawning a child off the (now-released) root 409s, the same way
    // it already would for any agent that isn't live.
    const res = await call("POST", `/runs/${runId}/agents`, {
      spec: spec("child"),
      parentAgentId: rootAgentId,
    });
    expect(res.status).toBe(409);
  });

  test("waits for every member, not just the root", async () => {
    const { runId, rootAgentId } = await startRun({
      spec: spec("root", { spawnDepth: 1 }),
      closeWhen: "quiescent",
    });

    // Spawn the child BEFORE the root ever gets a turn, so the subtree has two members from
    // the start — the root finishing alone must not look quiescent while the child hasn't
    // even started yet, let alone while it's gated below.
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { agentId: childId } = await spawnChild(runId, rootAgentId);
    await call("POST", `/agents/${childId}/prompt`, { text: "work" });

    await call("POST", `/agents/${rootAgentId}/prompt`, { text: "hi" });
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");

    // The root is done; the child is still gated mid-turn. The run must stay open.
    await Bun.sleep(20);
    expect((await call("GET", `/runs/${runId}`)).body.state).toBe("open");

    gate.resolve();
    await until(async () => (await call("GET", `/agents/${childId}`)).body.state === "done");
    await until(async () => (await call("GET", `/runs/${runId}`)).body.state === "closed");
  });

  test("a direct stop on the last live member closes the run with no duplicate release", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { runId, rootAgentId } = await startRun({ prompt: "long task", closeWhen: "quiescent" });

    // stopAgent() (not deleteRun) closes the sandbox itself as part of aborting a live
    // agent — no separate "agent.released" for that path (only `agent.ended`, outcome
    // aborted) — and does so BEFORE emitting agent.ended. By the time the reactive trigger
    // below sees that event, the agent is already gone from the registry. finalizeRun must
    // not try to release it again; see the guard in finalizeRun's loop.
    const res = await call("POST", `/agents/${rootAgentId}/stop`, {});
    expect(res.status).toBe(202);

    await until(async () => (await call("GET", `/runs/${runId}`)).body.state === "closed");
    expect(events(runId).filter((e) => e.event === "agent.released")).toHaveLength(0);
    expect(events(runId).filter((e) => e.event === "agent.ended")).toHaveLength(1);
    expect(events(runId).filter((e) => e.event === "run.closed")).toHaveLength(1);
    gate.resolve();
  });

  test("a closeWhen: explicit run (the default) never auto-closes", async () => {
    const { runId } = await startRun({ prompt: "say hi" });
    await until(async () => (await call("GET", `/runs/${runId}`)).body.agents[0]?.state === "done");
    await Bun.sleep(20);
    expect((await call("GET", `/runs/${runId}`)).body.state).toBe("open");
    expect(events(runId).map((e) => e.event)).not.toContain("run.closed");
  });

  test("a pending inbox entry blocks auto-close, and delivery that wakes a new turn doesn't close mid-turn", async () => {
    const { runId, rootAgentId, root } = await startRun({
      spec: spec("root", { spawnDepth: 1 }),
      closeWhen: "quiescent",
    });

    // Spawn and register the subscription before either member has a turn, so the subtree
    // always has two members — the root finishing alone can never look quiescent first.
    const { agentId: childId } = await spawnChild(runId, rootAgentId);
    await call("POST", `/agents/${rootAgentId}/notify-on`, { agents: [childId] });

    await call("POST", `/agents/${rootAgentId}/prompt`, { text: "hi" });
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");
    await Bun.sleep(20);
    expect((await call("GET", `/runs/${runId}`)).body.state).toBe("open");

    // The root watches the child — ending it queues an inbox entry for the root (idle: held
    // for its next prompt).
    await call("POST", `/agents/${childId}/prompt`, { text: "work" });
    await until(async () => (await call("GET", `/agents/${childId}`)).body.state === "done");

    // Every member is terminal now, but the root has a pending notification — not quiescent yet.
    await Bun.sleep(20);
    expect((await call("GET", `/runs/${runId}`)).body.state).toBe("open");
    expect((await call("GET", `/agents/${rootAgentId}/inbox`)).body.pending).not.toHaveLength(0);

    // Deliver it: the root is idle, so this wakes it into a brand-new turn (notify.ts's
    // deliverNow, `as: "turn"`) rather than clearing the inbox in place. Gate that turn so an
    // incorrect close-on-delivery (the race §3.4's comment describes) would show up as the run
    // closing while the gate is still held — it must not.
    const gate = deferred();
    root.turn = { gate: gate.promise };
    await call("POST", `/agents/${rootAgentId}/inbox/deliver`);
    await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "running");
    await Bun.sleep(20);
    expect((await call("GET", `/runs/${runId}`)).body.state).toBe("open");

    // Only once that revived turn actually finishes does the run have nothing left and close.
    gate.resolve();
    await until(async () => (await call("GET", `/runs/${runId}`)).body.state === "closed");
  });
});

describe("DELETE /runs/:runId is idempotent against an auto-close", () => {
  test("a second DELETE on an already-closed run is a clean no-op", async () => {
    const { runId } = await startRun({ prompt: "say hi", closeWhen: "quiescent" });
    await until(async () => (await call("GET", `/runs/${runId}`)).body.state === "closed");

    const res = await call("DELETE", `/runs/${runId}`);
    expect(res.status).toBe(204);
    expect(events(runId).filter((e) => e.event === "run.closed")).toHaveLength(1);
  });

  test("DELETE on an explicit run still emits run.closed, exactly once", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise };
    const { runId, root } = await startRun({ prompt: "long task" });

    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(204);
    expect(root.aborted).toBe(true);
    expect(root.closed).toBe(true);
    expect(events(runId).filter((e) => e.event === "run.closed")).toHaveLength(1);
    expect(events(runId).find((e) => e.event === "run.closed")?.reason).toBe("explicit");
    gate.resolve();

    // Idempotent on a repeat, same as the quiescent path above.
    expect((await call("DELETE", `/runs/${runId}`)).status).toBe(204);
    expect(events(runId).filter((e) => e.event === "run.closed")).toHaveLength(1);
  });
});

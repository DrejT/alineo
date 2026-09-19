/** Tier 2 coordination: waitFor regimes + deadline (#3), quiescence + operator await (#4). */
import { afterEach, describe, expect, test } from "bun:test";
import { getAgentRow } from "../src/state/projection";
import { parseStoredWait } from "../src/engine/waitfor";
import { call, deferred, events, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk, type FakeAgent } from "./fakes";

afterEach(() => fakeSdk.reset());

const rootSpec = { spec: spec("root", { spawnDepth: 3 }) };

/** Spawn a dependency whose turn is held open until `gate` resolves (or finishes at once). */
async function dep(
  runId: string,
  parentId: string,
  name: string,
  turn: { gate?: Promise<void>; text?: string | null; error?: string } = {},
) {
  fakeSdk.nextTurn = { text: `${name} result`, ...turn };
  return spawnChild(runId, parentId, { spec: spec(name), prompt: name });
}

async function spawnHeld(runId: string, parentId: string, waitFor: unknown, name = "gather") {
  const res = await call("POST", `/runs/${runId}/agents`, {
    parentAgentId: parentId,
    spec: spec(name),
    waitFor,
    prompt: "combine",
  });
  return res;
}

async function ended(agentId: string) {
  return until(
    () => (getAgentRow(agentId)?.ended_at ? getAgentRow(agentId) : null),
    `${agentId} to end`,
  );
}

function forkedChild(parent: FakeAgent, name: string): FakeAgent | undefined {
  return parent.spawns.find((s) => s.child.name === name)?.child;
}

function manifest(child: FakeAgent): Record<string, unknown> {
  return JSON.parse(child.files.get("/inputs.json") ?? "{}") as Record<string, unknown>;
}

describe("waitFor regimes", () => {
  test("all: a failed dependency ends the child failed without forking", async () => {
    const run = await startRun(rootSpec);
    const a = await dep(run.runId, run.rootAgentId, "a");
    const b = await dep(run.runId, run.rootAgentId, "b", { text: null, error: "provider 500" });
    const res = await spawnHeld(run.runId, run.rootAgentId, {
      agents: [a.agentId, b.agentId],
      mode: "all",
    });

    const row = await ended(res.body.agentId);
    expect(row).toMatchObject({ state: "failed", outcome: "failed" });
    expect(forkedChild(run.root, "gather")).toBeUndefined();
    const endedEv = events(run.runId).find(
      (e) => e.event === "agent_ended" && e.agentId === res.body.agentId,
    );
    expect(endedEv?.error).toContain(`dep-failed: ${b.agentId}`);
    expect(
      events(run.runId).find((e) => e.event === "wait_resolved" && e.agentId === res.body.agentId),
    ).toMatchObject({ mode: "all", outcome: "depfail" });
  });

  test("all with onDepFailure: proceed still forks, with every input", async () => {
    const run = await startRun(rootSpec);
    const a = await dep(run.runId, run.rootAgentId, "a");
    const b = await dep(run.runId, run.rootAgentId, "b", { text: null, error: "provider 500" });
    await spawnHeld(run.runId, run.rootAgentId, {
      agents: [a.agentId, b.agentId],
      mode: "all",
      onDepFailure: "proceed",
    });
    const child = await until(() => forkedChild(run.root, "gather"), "gather to fork");
    expect(
      Object.keys(manifest(child))
        .filter((k) => k !== "__wait")
        .sort(),
    ).toEqual([a.agentId, b.agentId].sort());
  });

  test("any: the child starts on the first dependency to settle, with only its input", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    const b = await dep(run.runId, run.rootAgentId, "b");
    await spawnHeld(run.runId, run.rootAgentId, { agents: [a.agentId, b.agentId], mode: "any" });

    const child = await until(() => forkedChild(run.root, "gather"), "gather to fork");
    const m = manifest(child);
    expect(m[b.agentId]).toBeDefined();
    expect(m[a.agentId]).toBeUndefined();
    expect(m.__wait).toMatchObject({ mode: "any", outcome: "satisfied" });
    expect(child.files.get(`/inputs/${b.agentId}.txt`)).toBe("b result");
    slow.resolve();
  });

  test("quorum: the first k successes win; an unreachable quorum fails", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a");
    const b = await dep(run.runId, run.rootAgentId, "b");
    const c = await dep(run.runId, run.rootAgentId, "c", { gate: slow.promise });
    await spawnHeld(
      run.runId,
      run.rootAgentId,
      { agents: [a.agentId, b.agentId, c.agentId], mode: "quorum", k: 2 },
      "quorum-ok",
    );
    const child = await until(() => forkedChild(run.root, "quorum-ok"), "quorum child to fork");
    expect(
      Object.keys(manifest(child))
        .filter((k) => k !== "__wait")
        .sort(),
    ).toEqual([a.agentId, b.agentId].sort());

    const bad = await dep(run.runId, run.rootAgentId, "bad", { text: null, error: "boom" });
    const res = await spawnHeld(
      run.runId,
      run.rootAgentId,
      { agents: [a.agentId, bad.agentId], mode: "quorum", k: 2 },
      "quorum-bad",
    );
    expect(await ended(res.body.agentId)).toMatchObject({ outcome: "failed" });
    slow.resolve();
  });

  test("a deadline proceeds with what settled (partial), or fails the child", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    const b = await dep(run.runId, run.rootAgentId, "b");

    await spawnHeld(
      run.runId,
      run.rootAgentId,
      { agents: [a.agentId, b.agentId], deadlineSec: 0.3 },
      "partial",
    );
    const child = await until(() => forkedChild(run.root, "partial"), "partial child to fork");
    expect(manifest(child).__wait).toMatchObject({
      mode: "settled",
      outcome: "partial",
      pending: [a.agentId],
    });

    const res = await spawnHeld(
      run.runId,
      run.rootAgentId,
      { agents: [a.agentId], deadlineSec: 0.3, onDeadline: "fail" },
      "strict",
    );
    const row = await ended(res.body.agentId);
    expect(row).toMatchObject({ outcome: "failed" });
    expect(
      events(run.runId).find((e) => e.event === "agent_ended" && e.agentId === res.body.agentId)
        ?.error,
    ).toContain("wait-deadline");
    slow.resolve();
  });

  test("waiting on a paused dependency is reported, and resolves once it finishes", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    const res = await spawnHeld(run.runId, run.rootAgentId, [a.agentId]);
    await call("POST", `/agents/${a.agentId}/pause`);
    await until(
      () =>
        events(run.runId).find(
          (e) => e.event === "wait_blocked_on_paused" && e.agentId === res.body.agentId,
        ),
      "wait_blocked_on_paused",
    );
    await call("POST", `/agents/${a.agentId}/resume`);
    slow.resolve();
    await until(() => forkedChild(run.root, "gather"), "gather to fork");
  });

  test("bad specs are rejected, and stored waits parse in both forms", async () => {
    const run = await startRun(rootSpec);
    const a = await dep(run.runId, run.rootAgentId, "a");
    expect(
      (await spawnHeld(run.runId, run.rootAgentId, { agents: [a.agentId], mode: "quorum", k: 2 }))
        .status,
    ).toBe(400);
    expect(
      (await spawnHeld(run.runId, run.rootAgentId, { agents: [a.agentId, a.agentId] })).status,
    ).toBe(400);
    expect((await spawnHeld(run.runId, run.rootAgentId, { agents: ["a_nope"] })).status).toBe(400);

    expect(parseStoredWait('["a_1","a_2"]')).toMatchObject({
      agents: ["a_1", "a_2"],
      mode: "settled",
    });
    expect(parseStoredWait('{"agents":["a_1"],"mode":"any","deadlineAt":123}')).toMatchObject({
      mode: "any",
      deadlineAt: 123,
    });
  });
});

describe("quiescence", () => {
  test("a subtree is quiescent only once every member is terminal; a waiter sees the transition", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    await call("POST", `/agents/${run.rootAgentId}/stop`); // root itself ends; a keeps running

    const now = await call("GET", `/agents/${run.rootAgentId}/await?scope=subtree`);
    expect(now.body).toMatchObject({ quiescent: false });

    const pending = call("GET", `/agents/${run.rootAgentId}/await?scope=subtree&wait=5`);
    await Bun.sleep(50);
    slow.resolve();
    const res = await pending;
    expect(res.body.quiescent).toBe(true);
    expect(res.body.members.map((m: { agentId: string }) => m.agentId).sort()).toEqual(
      [run.rootAgentId, a.agentId].sort(),
    );
    expect(
      events(run.runId).some(
        (e) => e.event === "subtree_quiescent" && e.agentId === run.rootAgentId,
      ),
    ).toBe(true);
  });

  test("paused members block quiescence and are reported; so does a spawn still in flight", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    await call("POST", `/agents/${a.agentId}/pause`);
    const res = await call("GET", `/agents/${a.agentId}/await`);
    expect(res.body).toMatchObject({ quiescent: false, blockedOnPaused: [a.agentId] });

    await call("POST", `/agents/${a.agentId}/resume`);
    const held = await spawnHeld(run.runId, run.rootAgentId, [a.agentId]);
    const view = await call("GET", `/agents/${run.rootAgentId}/await`);
    expect(view.body.quiescent).toBe(false);
    expect(
      view.body.members.find((m: { agentId: string }) => m.agentId === held.body.agentId)?.state,
    ).toBe("spawning");
    slow.resolve();
    expect((await call("GET", "/agents/a_nope/await")).status).toBe(404);
  });
});

describe("POST /runs/:runId/await", () => {
  test("resolves a regime without spawning, or reports what's pending at the timeout", async () => {
    const run = await startRun(rootSpec);
    const slow = deferred();
    const a = await dep(run.runId, run.rootAgentId, "a", { gate: slow.promise });
    const b = await dep(run.runId, run.rootAgentId, "b");
    await until(() => getAgentRow(b.agentId)?.state === "done", "b done");

    const any = await call("POST", `/runs/${run.runId}/await`, {
      agents: [a.agentId, b.agentId],
      mode: "any",
    });
    expect(any.body).toMatchObject({ outcome: "satisfied", selected: [b.agentId] });

    const all = await call("POST", `/runs/${run.runId}/await`, {
      agents: [a.agentId, b.agentId],
      mode: "all",
      wait: 0.2,
    });
    expect(all.body).toMatchObject({ outcome: "pending", pending: [a.agentId] });
    expect(all.body.settled.map((s: { agentId: string }) => s.agentId)).toEqual([b.agentId]);

    const subtree = await call("POST", `/runs/${run.runId}/await`, { subtree: b.agentId });
    expect(subtree.body.outcome).toBe("satisfied");

    expect((await call("POST", `/runs/${run.runId}/await`, {})).status).toBe(400);
    expect(
      (await call("POST", `/runs/${run.runId}/await`, { agents: [a.agentId], subtree: a.agentId }))
        .status,
    ).toBe(400);
    slow.resolve();
  });
});

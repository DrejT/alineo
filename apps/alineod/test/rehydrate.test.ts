/**
 * Crash-only recovery. Each test builds the ledger a crashed alineod would have left behind,
 * drops every open connection (a fresh process has none), then runs rehydrate().
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emit } from "../src/engine/emit";
import { get } from "../src/engine/registry";
import { rehydrate } from "../src/engine/rehydrate";
import { newAgentId, newRunId } from "../src/ids";
import { getAgentRow, getHandle } from "../src/state/projection";
import { events, spec, until, wipeState } from "./helpers";
import { FakeAgent, fakeSdk } from "./fakes";

beforeEach(() => wipeState());
afterEach(() => fakeSdk.reset());

interface Seed {
  runId: string;
  name?: string;
  parentAgentId?: string | null;
  depth?: number;
  sandbox?: FakeAgent | null;
  state?: string;
  waitFor?: string[];
  prompt?: string;
  ended?: string;
}

/** Write the ledger rows for one agent as a crashed process would have left them. */
function seed(s: Seed): string {
  const id = newAgentId();
  const name = s.name ?? "agent";
  emit(s.runId, id, "agent_spawned", {
    parentAgentId: s.parentAgentId ?? null,
    runId: s.runId,
    specName: name,
    specJson: JSON.stringify(spec(name)),
    depth: s.depth ?? (s.parentAgentId ? 1 : 0),
    spawnIndex: 0,
    sandboxId: null,
    spawnBudget: s.parentAgentId ? 1 : 2,
    maxAgentsBudget: null,
    waitFor: s.waitFor ?? null,
    prompt: s.prompt ?? null,
  });
  if (s.sandbox) emit(s.runId, id, "agent_provisioned", { sandboxId: s.sandbox.sandboxId });
  if (s.state) emit(s.runId, id, "agent_state_changed", { from: "provisioning", to: s.state });
  if (s.ended) {
    emit(s.runId, id, "handle_settled", { outcome: s.ended, resultRef: null });
    emit(s.runId, id, "agent_ended", { outcome: s.ended, endedAt: Date.now() });
  }
  return id;
}

function container(runId: string, name = "agent"): FakeAgent {
  return new FakeAgent({ name, runId });
}

describe("agents with a sandbox", () => {
  test("reattach without restarting the bridge", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    const id = seed({ runId, sandbox });

    await rehydrate();

    expect(get(id)).toBe(sandbox as never);
    expect(fakeSdk.calls.reattach).toEqual([sandbox.sandboxId]);
    expect(fakeSdk.calls.resume).toEqual([]);
    expect(getAgentRow(id)?.state).toBe("provisioning");
  });

  test("fall back to resume when the bridge doesn't answer", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    const id = seed({ runId, sandbox });
    fakeSdk.reattachFails.add(sandbox.sandboxId);

    await rehydrate();

    expect(get(id)).toBe(sandbox as never);
    expect(fakeSdk.calls.resume).toEqual([sandbox.sandboxId]);
  });

  test("are marked lost when neither reattach nor resume works", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    const id = seed({ runId, sandbox });
    fakeSdk.reattachFails.add(sandbox.sandboxId);
    fakeSdk.resumeFails.add(sandbox.sandboxId);

    await rehydrate();

    expect(get(id)).toBeUndefined();
    expect(getAgentRow(id)).toMatchObject({ state: "lost", outcome: "lost" });
    expect(getHandle(id)?.state).toBe("settled");
  });

  test("a turn that was in flight is caught up and its result recorded exactly once", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    sandbox.streaming = true; // Pi is still mid-turn inside the container
    const id = seed({ runId, sandbox, state: "running" });

    await rehydrate();
    expect(getHandle(id)?.state).toBe("pending");

    sandbox.lastText = "finished while alineod was down";
    sandbox.streaming = false;

    await until(() => getHandle(id)?.state === "settled", "catch-up settle", 6_000);
    expect(getHandle(id)).toMatchObject({ outcome: "success", result_ref: `fs://${id}/result.md` });
    expect(getAgentRow(id)).toMatchObject({ state: "done", outcome: "success" });

    await Bun.sleep(100);
    expect(
      events(runId).filter((e) => e.event === "handle_settled" && e.agentId === id),
    ).toHaveLength(1);
  }, 10_000);

  test("a finished agent with an open sandbox is reconnected so it can be prompted again", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    const id = seed({ runId, sandbox, state: "running", ended: "success" });

    await rehydrate();

    expect(get(id)).toBe(sandbox as never);
    expect(fakeSdk.calls.reattach).toEqual([sandbox.sandboxId]);
    // Already settled before the crash — no catch-up poll needed, and its recorded outcome
    // is untouched by being reconnected.
    expect(getAgentRow(id)).toMatchObject({ state: "done", outcome: "success" });
  });

  test("an aborted (closed) agent is left alone — its sandbox is genuinely gone", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    seed({ runId, sandbox, ended: "aborted" });

    await rehydrate();

    expect(fakeSdk.calls.reattach).toEqual([]);
    expect(fakeSdk.calls.resume).toEqual([]);
  });

  test("an already-lost agent is not retried again this boot", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    seed({ runId, sandbox, ended: "lost" });

    await rehydrate();

    expect(fakeSdk.calls.reattach).toEqual([]);
  });

  test("a finished agent that can't be reconnected keeps its real outcome instead of becoming lost", async () => {
    const runId = newRunId();
    const sandbox = container(runId);
    const id = seed({ runId, sandbox, ended: "failed" });
    fakeSdk.reattachFails.add(sandbox.sandboxId);
    fakeSdk.resumeFails.add(sandbox.sandboxId);

    await rehydrate();

    expect(get(id)).toBeUndefined();
    expect(getAgentRow(id)).toMatchObject({ state: "failed", outcome: "failed" });
  });
});

describe("agents that hadn't forked yet", () => {
  test("a gather held by waitFor is retried: it waits, forks, gets its inputs, and runs its prompt", async () => {
    const runId = newRunId();
    const rootBox = container(runId, "root");
    const root = seed({
      runId,
      name: "root",
      sandbox: rootBox,
      state: "running",
      ended: "success",
    });

    const workerBox = container(runId, "worker");
    workerBox.lastText = "worker output";
    const worker = seed({
      runId,
      name: "worker",
      parentAgentId: root,
      sandbox: workerBox,
      state: "running",
    });

    const gather = seed({
      runId,
      name: "gather",
      parentAgentId: root,
      state: "spawning",
      waitFor: [worker],
      prompt: "combine the inputs",
    });

    await rehydrate();

    await until(() => getAgentRow(gather)?.sandbox_id, "gather to fork", 6_000);
    const child = rootBox.spawns[0]!.child;
    expect(getAgentRow(gather)?.sandbox_id).toBe(child.sandboxId);
    expect(child.files.get(`/inputs/${worker}.txt`)).toBe("worker output");
    expect(JSON.parse(child.files.get("/inputs.json")!)).toEqual({
      [worker]: { path: `/inputs/${worker}.txt`, outcome: "success" },
    });
    await until(() => child.prompts.includes("combine the inputs"), "gather prompt");
  }, 10_000);

  test("a child whose parent already finished its own turn still forks from the parent's sandbox", async () => {
    const runId = newRunId();
    const rootBox = container(runId, "root");
    const root = seed({ runId, name: "root", sandbox: rootBox, ended: "success" });
    const child = seed({ runId, name: "child", parentAgentId: root });

    await rehydrate();

    await until(() => getAgentRow(child)?.sandbox_id, "child to fork");
    expect(fakeSdk.calls.reattach).toEqual([rootBox.sandboxId]);
    expect(rootBox.spawns).toHaveLength(1);
  });

  test("a root still being provisioned is loaded again and its prompt run", async () => {
    const runId = newRunId();
    const root = seed({ runId, name: "root", prompt: "start" });

    await rehydrate();

    const sandboxId = await until(() => getAgentRow(root)?.sandbox_id, "root to provision");
    expect(fakeSdk.calls.load).toBe(1);
    await until(() => fakeSdk.sandboxes.get(sandboxId)?.prompts.includes("start"), "root prompt");
  });

  test("a child whose parent can't be reconnected is marked lost", async () => {
    const runId = newRunId();
    const rootBox = container(runId, "root");
    const root = seed({ runId, name: "root", sandbox: rootBox, state: "running" });
    const child = seed({ runId, name: "child", parentAgentId: root });
    fakeSdk.reattachFails.add(rootBox.sandboxId);
    fakeSdk.resumeFails.add(rootBox.sandboxId);

    await rehydrate();

    await until(() => getAgentRow(child)?.state === "lost", "child lost");
    const ended = events(runId).find((e) => e.event === "agent_ended" && e.agentId === child);
    expect(ended?.error).toContain("did not come back");
  });
});

/** The ledger → projection fold: the only writer of `agents` and `handles`. */
import { describe, expect, test } from "bun:test";
import { emit } from "../src/engine/emit";
import { getAgentRow, getHandle, liveAgents, rebuild, runAsOf } from "../src/state/projection";
import { appendRow } from "../src/state/db";
import { newAgentId, newRunId } from "../src/ids";

function seedAgent(runId: string, agentId = newAgentId()) {
  emit(runId, agentId, "agent_spawned", {
    parentAgentId: null,
    runId,
    specName: "worker",
    specJson: JSON.stringify({ name: "worker", harness: "pi" }),
    depth: 0,
    spawnIndex: 0,
    sandboxId: null,
    spawnBudget: 2,
    maxAgentsBudget: null,
    waitFor: ["a_dep"],
    prompt: "do it",
  });
  return agentId;
}

describe("apply()", () => {
  test("agent_spawned creates a provisioning agent with a pending handle and persisted intent", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    const row = getAgentRow(id)!;
    expect(row.state).toBe("provisioning");
    expect(row.spawn_budget).toBe(2);
    expect(JSON.parse(row.wait_for!)).toEqual(["a_dep"]);
    expect(row.prompt).toBe("do it");
    expect(getHandle(id)?.state).toBe("pending");
  });

  test("agent_state_changed and agent_provisioned update state and sandbox", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    emit(runId, id, "agent_state_changed", { from: "provisioning", to: "running" });
    emit(runId, id, "agent_provisioned", { sandboxId: "sb-x" });
    const row = getAgentRow(id)!;
    expect(row.state).toBe("running");
    expect(row.sandbox_id).toBe("sb-x");
  });

  test.each([
    ["success", "done"],
    ["failed", "failed"],
    ["aborted", "aborted"],
    ["lost", "lost"],
    ["budget-exceeded", "failed"],
  ])("agent_ended with outcome %s → state %s", (outcome, state) => {
    const runId = newRunId();
    const id = seedAgent(runId);
    emit(runId, id, "agent_ended", { outcome, endedAt: Date.now() });
    const row = getAgentRow(id)!;
    expect(row.state).toBe(state);
    expect(row.outcome).toBe(outcome);
    expect(row.ended_at).not.toBeNull();
  });

  test("agent_ended settles a still-pending handle", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    emit(runId, id, "agent_ended", { outcome: "aborted", endedAt: Date.now() });
    expect(getHandle(id)).toMatchObject({ state: "settled", outcome: "aborted", result_ref: null });
  });

  test("agent_ended never overwrites a handle that handle_settled already resolved", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    emit(runId, id, "handle_settled", { outcome: "success", resultRef: `fs://${id}/result.md` });
    emit(runId, id, "agent_ended", { outcome: "failed", endedAt: Date.now() });
    expect(getHandle(id)).toMatchObject({
      state: "settled",
      outcome: "success",
      result_ref: `fs://${id}/result.md`,
    });
  });

  test("forwarded harness events don't touch the projections", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    appendRow(runId, id, "tool_start", { agentId: id, toolName: "bash" });
    expect(getAgentRow(id)?.state).toBe("provisioning");
  });
});

describe("readers", () => {
  test("liveAgents() is exactly provisioning, spawning, running, and paused", () => {
    const runId = newRunId();
    const byState: Record<string, string> = {};
    for (const to of ["provisioning", "spawning", "running", "paused"]) {
      const id = seedAgent(runId);
      if (to !== "provisioning")
        emit(runId, id, "agent_state_changed", { from: "provisioning", to });
      byState[to] = id;
    }
    const done = seedAgent(runId);
    emit(runId, done, "agent_ended", { outcome: "success", endedAt: Date.now() });

    const live = new Set(liveAgents().map((a) => a.agent_id));
    for (const id of Object.values(byState)) expect(live.has(id)).toBe(true);
    expect(live.has(done)).toBe(false);
  });

  test("runAsOf() is the run's highest ledger seq", () => {
    const runId = newRunId();
    const id = seedAgent(runId);
    const last = emit(runId, id, "agent_steered", { message: "x" });
    expect(runAsOf(runId)).toBe(last);
    expect(runAsOf(newRunId())).toBe(0);
  });
});

test("rebuild() refolds the projections to exactly what incremental apply() produced", () => {
  const runId = newRunId();
  const id = seedAgent(runId);
  emit(runId, id, "agent_provisioned", { sandboxId: "sb-rebuild" });
  emit(runId, id, "agent_state_changed", {
    from: "provisioning",
    to: "paused",
    reason: "operator",
  });
  emit(runId, id, "handle_settled", { outcome: "success", resultRef: "fs://x/result.md" });
  const before = { row: getAgentRow(id), handle: getHandle(id) };

  rebuild();

  expect(getAgentRow(id)).toEqual(before.row);
  expect(getHandle(id)).toEqual(before.handle);
});

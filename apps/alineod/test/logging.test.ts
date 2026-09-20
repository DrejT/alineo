/** What alineod logs while it runs: lifecycle events, request errors — and what it must never log. */
import { afterEach, describe, expect, test } from "bun:test";
import { installLogger, resetLogger } from "@alineo-labs/logger";
import type { LevelSetting, LogRecord } from "@alineo-labs/logger";
import { HttpError } from "../src/engine/errors";
import { emit, emitHarness } from "../src/engine/emit";
import { newAgentId, newRunId } from "../src/ids";
import { toErrorResponse } from "../src/routes/http";

let records: LogRecord[] = [];

function capture(level: LevelSetting = "info") {
  records = [];
  installLogger({
    level,
    sink: (r) => {
      records.push(r);
    },
  });
}

afterEach(resetLogger);

function spawned(runId: string, agentId = newAgentId()) {
  emit(runId, agentId, "agent_spawned", {
    parentAgentId: null,
    runId,
    specName: "worker",
    specJson: JSON.stringify({ name: "worker", cli: "pi", env: { KEY: "sekret-value" } }),
    depth: 0,
    spawnIndex: 0,
    sandboxId: null,
    spawnBudget: 2,
    maxAgentsBudget: null,
    waitFor: null,
    prompt: "SUPER SECRET PROMPT",
  });
  return agentId;
}

describe("lifecycle events", () => {
  test("agent_spawned logs ids, seq and the safe fields", () => {
    capture();
    const runId = newRunId();
    const agentId = spawned(runId);
    expect(records).toHaveLength(1);
    const [rec] = records;
    expect(rec).toMatchObject({ level: "info", component: "alineod", msg: "agent_spawned" });
    expect(rec?.fields).toMatchObject({
      runId,
      agentId,
      specName: "worker",
      depth: 0,
      spawnIndex: 0,
    });
    expect(typeof rec?.fields.seq).toBe("number");
  });

  test("never logs prompts, specs or env values", () => {
    capture("debug");
    spawned(newRunId());
    const everything = JSON.stringify(records);
    expect(everything).not.toContain("SUPER SECRET PROMPT");
    expect(everything).not.toContain("sekret-value");
    expect(everything).not.toContain("specJson");
  });

  test("never logs a steer message", () => {
    capture("debug");
    const runId = newRunId();
    const agentId = spawned(runId);
    records.length = 0;
    emit(runId, agentId, "agent_steered", { message: "do not log me" });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("do not log me");
  });

  test("agent_ended: success and a user stop are info; failed and lost are warn, with the error", () => {
    capture();
    const runId = newRunId();
    const outcomes = ["success", "aborted", "failed", "lost"] as const;
    const ids = outcomes.map(() => spawned(runId));
    records.length = 0;
    outcomes.forEach((outcome, i) => {
      emit(runId, ids[i] ?? null, "agent_ended", {
        outcome,
        endedAt: Date.now(),
        ...(outcome === "failed" ? { error: "model returned 410" } : {}),
      });
    });
    expect(records.map((r) => [r.fields.outcome, r.level])).toEqual([
      ["success", "info"],
      ["aborted", "info"],
      ["failed", "warn"],
      ["lost", "warn"],
    ]);
    expect(records[2]?.fields.error).toBe("model returned 410");
  });

  test("long error text is truncated", () => {
    capture();
    const runId = newRunId();
    const id = spawned(runId);
    records.length = 0;
    emit(runId, id, "agent_ended", { outcome: "failed", endedAt: 1, error: "x".repeat(5000) });
    const error = String(records[0]?.fields.error);
    expect(error.length).toBeLessThan(250);
    expect(error.endsWith("…")).toBe(true);
  });

  test("budget_denied is a warning", () => {
    capture();
    const runId = newRunId();
    const id = spawned(runId);
    records.length = 0;
    emit(runId, id, "budget_denied", { dimension: "maxAgents" });
    expect(records[0]).toMatchObject({ level: "warn", msg: "budget_denied" });
    expect(records[0]?.fields.dimension).toBe("maxAgents");
  });

  test("bookkeeping events (inbox_, wait_, notify_) are debug-only", () => {
    const runId = newRunId();
    const id = spawned(runId);
    capture("info");
    emit(runId, id, "inbox_queued", { count: 1 });
    expect(records).toHaveLength(0);
    capture("debug");
    emit(runId, id, "inbox_queued", { count: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("debug");
  });

  test("logs nothing when no logger is installed", () => {
    resetLogger();
    expect(() => spawned(newRunId())).not.toThrow();
  });
});

describe("harness events", () => {
  test("persisted ones log at debug with the tool NAME only, never its arguments", () => {
    capture("debug");
    const runId = newRunId();
    const agentId = spawned(runId);
    records.length = 0;
    emitHarness(runId, agentId, {
      type: "tool_start",
      toolName: "bash",
      args: { command: "rm -rf /secret" },
    });
    emitHarness(runId, agentId, { type: "tool_end", toolName: "bash", isError: true });
    expect(records.map((r) => [r.msg, r.level])).toEqual([
      ["tool_start", "debug"],
      ["tool_end", "debug"],
    ]);
    expect(records[0]?.fields.toolName).toBe("bash");
    expect(records[1]?.fields.isError).toBe(true);
    expect(JSON.stringify(records)).not.toContain("rm -rf");
  });

  test("streaming deltas are not logged, and nothing is logged at info", () => {
    capture("debug");
    const runId = newRunId();
    const agentId = spawned(runId);
    records.length = 0;
    emitHarness(runId, agentId, { type: "text", delta: "hello" });
    expect(records).toHaveLength(0);
    capture("info");
    emitHarness(runId, agentId, { type: "tool_start", toolName: "bash" });
    expect(records).toHaveLength(0);
  });
});

describe("request errors", () => {
  const request = new Request("http://alineod.test/agents/a_1/prompt", { method: "POST" });

  test("an unexpected error is logged at error with the request — and the response is unchanged", async () => {
    capture();
    const boom = new Error("boom");
    const res = toErrorResponse(boom, { request, code: "UNKNOWN" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: "error", msg: "unhandled error" });
    expect(records[0]?.fields).toMatchObject({
      method: "POST",
      path: "/agents/a_1/prompt",
      err: boom,
    });
  });

  test("an HttpError is an expected rejection: debug, with status and path", async () => {
    capture("info");
    const res = toErrorResponse(new HttpError(409, "budget denied"), { request });
    expect(res.status).toBe(409);
    expect(records).toHaveLength(0);
    capture("debug");
    toErrorResponse(new HttpError(409, "budget denied"), { request });
    expect(records[0]).toMatchObject({ level: "debug", msg: "request rejected" });
    expect(records[0]?.fields).toMatchObject({ status: 409, path: "/agents/a_1/prompt" });
  });

  test("a client mistake (NOT_FOUND / VALIDATION) is not logged as an alineod bug", () => {
    capture("info");
    toErrorResponse(new Error("NOT_FOUND"), { request, code: "NOT_FOUND" });
    toErrorResponse(new Error("bad body"), { request, code: "VALIDATION" });
    expect(records).toHaveLength(0);
  });

  test("still works with no context (the old call shape)", () => {
    capture();
    expect(toErrorResponse(new Error("x")).status).toBe(500);
    expect(records[0]?.level).toBe("error");
  });
});

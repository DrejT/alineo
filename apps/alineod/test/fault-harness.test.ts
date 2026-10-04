/**
 * The fault harness (durability-roadmap.md M0.3 — "the backbone; every later chunk adds a
 * scenario to it"). Unlike rehydrate.test.ts's per-invariant unit tests against hand-seeded
 * ledger rows, each scenario here drives a REAL swarm through the real routes, injects a named
 * fault, and checks the shared invariants in ./fault/invariants.ts — the same invariants any
 * future scenario (tree-consistency's concurrency-storm, admission-control's admission-storm,
 * agent-supervision's chronic-failure) will check too, not a bespoke assertion per scenario.
 *
 * Run just this file: `bun run fault` (apps/alineod/package.json). Filter to one scenario the
 * same way `bun test` always filters: `bun run fault -- -t kill-9`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentRow, getHandle } from "../src/state/projection";
import { isCatchingUp } from "../src/engine/stream";
import { call, deferred, events, spec, startRun, until, wipeState } from "./helpers";
import { fakeSdk } from "./fakes";
import {
  assertCircuitBreakerBoundHolds,
  assertNoOrphanedPendingHandles,
  assertProjectionMatchesLedgerReplay,
} from "./fault/invariants";
import { simulateCrashAndRehydrate } from "./fault/simulate-crash";

beforeEach(() => wipeState());
afterEach(() => fakeSdk.reset());

describe("fault: kill-9 — alineod dies with a mid-turn worker and a held gather", () => {
  test("rehydrates clean, then finishes the swarm exactly as if it had never crashed", async () => {
    const coordinator = await startRun({ spec: spec("coordinator", { spawnDepth: 2 }) });

    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, text: "worker done" };
    const workerRes = await call("POST", `/runs/${coordinator.runId}/agents`, {
      parentAgentId: coordinator.rootAgentId,
      spec: spec("worker"),
      prompt: "do the work",
    });
    const workerId = workerRes.body.agentId as string;
    await until(() => getAgentRow(workerId)?.state === "running", "worker mid-turn");

    const gatherRes = await call("POST", `/runs/${coordinator.runId}/agents`, {
      parentAgentId: coordinator.rootAgentId,
      spec: spec("gather"),
      waitFor: [workerId],
      prompt: "combine",
    });
    const gatherId = gatherRes.body.agentId as string;
    await until(() => getAgentRow(gatherId)?.state === "spawning", "gather held on waitFor");

    // ── inject the fault ──────────────────────────────────────────────────
    await simulateCrashAndRehydrate();

    // ── invariants must hold immediately after rehydrate, before anything else runs ──
    assertProjectionMatchesLedgerReplay();
    assertNoOrphanedPendingHandles();
    // The worker was mid-turn at crash time — its ledger now carries a durable record of that,
    // distinct from a turn that ran straight through (durability-roadmap.md M1.2).
    expect(
      events(coordinator.runId).find(
        (e) => e.event === "agent.turn_interrupted" && e.agentId === workerId,
      ),
    ).toBeDefined();

    // ── the swarm still finishes correctly from here, exactly as if nothing happened ──
    gate.resolve();
    await until(() => getHandle(workerId)?.state === "settled", "worker settles post-rehydrate");
    expect(getAgentRow(workerId)).toMatchObject({ state: "done", outcome: "success" });

    await until(() => getAgentRow(gatherId)?.sandbox_id, "gather forks once its dep settles");
    await until(async () => {
      const view = await call("GET", `/agents/${gatherId}`);
      return view.body.state !== "spawning";
    }, "gather leaves the held state");

    // ── invariants must still hold once the swarm has finished progressing ──
    assertProjectionMatchesLedgerReplay();
    assertNoOrphanedPendingHandles();
  }, 10_000);
});

describe("fault: chronic-failure — an agent that always fails never costs more than its own bound", () => {
  test("a generous retry budget doesn't save it from a tight circuit breaker", async () => {
    const coordinator = await startRun({ spec: spec("coordinator", { spawnDepth: 2 }) });

    fakeSdk.nextTurn = { text: null, error: "the model API is permanently unavailable" };
    const workerRes = await call("POST", `/runs/${coordinator.runId}/agents`, {
      parentAgentId: coordinator.rootAgentId,
      // maxRetries is generous (100) on purpose — the whole point is that the circuit breaker,
      // not the retry budget, is what actually bounds the cost here.
      spec: spec("worker", { onFailure: "retry", maxRetries: 100, maxConsecutiveFailures: 3 }),
      prompt: "do the work",
    });
    const workerId = workerRes.body.agentId as string;

    const blocked = await until(
      () => getAgentRow(workerId)?.state === "blocked",
      "circuit to trip",
      6_000,
    );
    expect(blocked).toBe(true);
    const sandbox = fakeSdk.sandboxes.get(getAgentRow(workerId)!.sandbox_id!)!;
    expect(sandbox.prompts.length).toBe(3); // tripped at 3, nowhere near the 100-attempt budget
    expect(getHandle(workerId)?.state).toBe("pending"); // never settled, never will be on its own

    assertProjectionMatchesLedgerReplay();
    assertNoOrphanedPendingHandles();
    assertCircuitBreakerBoundHolds();
  }, 10_000);
});

describe("fault: kill-9-write-burst — a real process death during a write-heavy burst (M1.1)", () => {
  test("every acknowledged ledger row survives, and the file is not corrupted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alineod-write-burst-"));
    const dbPath = join(dir, "burst.db");
    const workerPath = join(import.meta.dir, "fault/write-burst-worker.ts");

    const proc = Bun.spawn(["bun", workerPath, dbPath], { stdout: "pipe", stderr: "pipe" });
    const state = { lastAcked: 0 };
    let leftover = "";
    const drained = (async () => {
      for await (const chunk of proc.stdout) {
        leftover += Buffer.from(chunk).toString("utf8");
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";
        for (const line of lines) {
          const seq = Number(line);
          if (Number.isFinite(seq) && seq > state.lastAcked) state.lastAcked = seq;
        }
      }
    })();

    // Let a real burst build up before killing it mid-stream — the point is to catch the
    // process while it is actively writing, not right after it starts.
    await until(() => state.lastAcked >= 200, "write burst to get going", 5_000);

    proc.kill(9);
    await proc.exited;
    // Bytes already sitting in the pipe at kill time are still delivered after the process is
    // gone — only once this resolves is state.lastAcked the final, true "acknowledged" count.
    await drained;
    expect(state.lastAcked).toBeGreaterThanOrEqual(200);

    const db = new Database(dbPath);
    const integrity = db.query("PRAGMA integrity_check;").all() as Array<{
      integrity_check: string;
    }>;
    expect(integrity).toEqual([{ integrity_check: "ok" }]);

    const row = db.query("SELECT COUNT(*) as n, MAX(seq) as max FROM ledger;").get() as {
      n: number;
      max: number;
    };
    // AUTOINCREMENT, one row per seq, no gaps: every row the worker said was acknowledged
    // actually made it to disk, and nothing else is missing in between.
    expect(row.max).toBeGreaterThanOrEqual(state.lastAcked);
    expect(row.n).toBe(row.max);
    db.close();
  }, 10_000);
});

describe("fault: kill-bridge — the bridge dies mid-turn, alineod does not (M2.1)", () => {
  test("alineod restarts it in place and reports the turn interrupted, not failed", async () => {
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, detach: true };
    const { runId, rootAgentId, root: agent } = await startRun({ prompt: "do the work" });
    await until(() => getAgentRow(rootAgentId)?.state === "running", "root mid-turn");

    // The bridge dies: the stream goes quiet (the SDK's own inactivity timeout fires, exactly
    // as it would for an idle-but-alive bridge) — but unlike an idle one, it never answers a
    // state probe again, because the process behind it is actually gone.
    agent.hangState = true;
    gate.resolve();

    await until(() => isCatchingUp(rootAgentId), "stream timeout hands the turn to catch-up");

    // Catch-up exhausts MAX_UNREACHABLE_PROBES probing the dead bridge and restarts it in
    // place — the fix this scenario exists to check.
    await until(
      () => fakeSdk.calls.resume.includes(agent.sandboxId),
      "catch-up restarts the dead bridge",
    );
    expect(
      events(runId).find((e) => e.event === "agent.turn_interrupted" && e.agentId === rootAgentId),
    ).toBeDefined();
    expect(
      events(runId).find((e) => e.event === "agent.turn_failed" && e.agentId === rootAgentId),
    ).toBeUndefined();

    // The restarted bridge is a fresh process: it answers probes again (hangState already
    // cleared by the fake's resume()) and reports the turn done, same idiom
    // rehydrate.test.ts's paused-agent resume tests use to stand in for "the new process
    // answers."
    agent.streaming = false;
    agent.lastText = "whatever survived";

    await until(() => getHandle(rootAgentId)?.state === "settled", "settles after restart");
    expect(getAgentRow(rootAgentId)).toMatchObject({ state: "done", outcome: "success" });
    assertProjectionMatchesLedgerReplay();
    assertNoOrphanedPendingHandles();

    // Proof this is a live connection, not a dead one: a fresh prompt actually reaches it.
    agent.turn = { text: "back online" };
    const res = await call("POST", `/agents/${rootAgentId}/prompt`, { text: "still there?" });
    expect(res.status).toBe(202);
    await until(
      () => agent.prompts.includes("still there?"),
      "new prompt reaches the restarted bridge",
    );
  }, 10_000);
});

describe("fault: bridge-disconnect — the connection closes without [DONE] (M2.1 follow-up)", () => {
  test("is treated as an interruption, not recorded as a silent false success", async () => {
    // Live on my-vps (2026-10-03): kill -9'ing the real bridge mid-tool-call settled the turn
    // as a false "success" with no text in under 20s — the real sseStream() can't tell a raw
    // connection close apart from the bridge's own [DONE] sentinel, so it never even reached
    // the inactivity-timeout/catch-up path the kill-bridge scenario above covers. The SDK now
    // throws BridgeDisconnectedError for this (packages/agent/src/adapters/pi.ts); this
    // scenario checks alineod's driveTurn routes that error to catch-up instead of settling
    // success immediately.
    const gate = deferred();
    fakeSdk.nextTurn = { gate: gate.promise, disconnect: true };
    const { runId, rootAgentId, root: agent } = await startRun({ prompt: "do the work" });
    await until(() => getAgentRow(rootAgentId)?.state === "running", "root mid-turn");

    agent.hangState = true;
    gate.resolve();

    await until(() => isCatchingUp(rootAgentId), "disconnect hands the turn to catch-up");
    await until(
      () => fakeSdk.calls.resume.includes(agent.sandboxId),
      "catch-up restarts the dead bridge",
    );
    expect(
      events(runId).find((e) => e.event === "agent.turn_interrupted" && e.agentId === rootAgentId),
    ).toBeDefined();

    agent.streaming = false;
    agent.lastText = "whatever survived";
    await until(() => getHandle(rootAgentId)?.state === "settled", "settles after restart");
    assertProjectionMatchesLedgerReplay();
    assertNoOrphanedPendingHandles();
  }, 10_000);
});

describe("fault: checkpoint — a turn that genuinely finishes is checkpointed (M3 3.2)", () => {
  test('agent.checkpointed follows agent.ended{outcome:"success"}, never before it', async () => {
    const { runId, rootAgentId } = await startRun({
      spec: spec("root", { checkpoint: true }),
      prompt: "do the work",
    });
    await until(() => getHandle(rootAgentId)?.state === "settled", "turn settles");

    const ended = events(runId).find((e) => e.event === "agent.ended" && e.agentId === rootAgentId);
    expect(ended).toMatchObject({ outcome: "success" });

    // maybeCheckpoint() is fire-and-forget (not awaited before driveTurn returns) — poll for it.
    const checkpointed = await until(
      () =>
        events(runId).find((e) => e.event === "agent.checkpointed" && e.agentId === rootAgentId),
      "checkpoint recorded",
    );
    expect(checkpointed).toMatchObject({ turn: 1 });
    expect(typeof checkpointed.snapshotRef).toBe("string");
    expect(checkpointed.seq).toBeGreaterThan(ended!.seq);
  });

  test("opt-in — no checkpoint event when AgentSpec.checkpoint is unset", async () => {
    const { runId, rootAgentId } = await startRun({ prompt: "do the work" });
    await until(() => getHandle(rootAgentId)?.state === "settled", "turn settles");
    // Give any (incorrectly fired) async checkpoint a moment to show up before asserting absence.
    await Bun.sleep(50);
    expect(
      events(runId).find((e) => e.event === "agent.checkpointed" && e.agentId === rootAgentId),
    ).toBeUndefined();
  });

  test("a failed turn is not checkpointed", async () => {
    fakeSdk.nextTurn = { error: "upstream refused the request" };
    const { runId, rootAgentId } = await startRun({
      spec: spec("root", { checkpoint: true }),
      prompt: "do the work",
    });
    await until(() => getHandle(rootAgentId)?.state === "settled", "turn settles");
    expect(
      events(runId).find((e) => e.event === "agent.ended" && e.agentId === rootAgentId),
    ).toMatchObject({ outcome: "failed" });
    await Bun.sleep(50);
    expect(
      events(runId).find((e) => e.event === "agent.checkpointed" && e.agentId === rootAgentId),
    ).toBeUndefined();
  });
});

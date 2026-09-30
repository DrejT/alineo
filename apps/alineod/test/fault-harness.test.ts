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
import { getAgentRow, getHandle } from "../src/state/projection";
import { call, deferred, spec, startRun, until, wipeState } from "./helpers";
import { fakeSdk } from "./fakes";
import {
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

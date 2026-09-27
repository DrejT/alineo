/**
 * The dual-write gate.
 *
 * alineod now writes each event twice: a ledger row, and a `LedgerEnvelope` handed to the
 * sinks. Two writes of the same fact is exactly the arrangement that drifts — one gets a new
 * field, the other does not, and nobody notices until a consumer of the second one is wrong.
 *
 * So: run a real coordinated swarm with a sink attached, then rebuild alineod's projections
 * from the sink's stream and deep-equal the result against `rebuild()` from the rows. If the
 * two writes ever disagree about what happened, this is where it surfaces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { memorySink, persistedOnly } from "@alineo-labs/ledger";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import { addSink, clearSinks } from "../src/engine/emit";
import { apply, rebuild, runAsOf } from "../src/state/projection";
import { db, readAllLedger, type LedgerRow } from "../src/state/db";
import { call, spawnChild, spec, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

const sink = memorySink();

beforeEach(() => {
  sink.clear();
  addSink(sink);
});

afterEach(() => {
  clearSinks();
});

/** An envelope, put back into the row shape `apply()` folds. */
function asRow(envelope: LedgerEnvelope): LedgerRow {
  return {
    seq: envelope.durable!.seq,
    run_id: envelope.runId!,
    agent_id: envelope.agentId ?? null,
    ts: envelope.ts,
    event: envelope.type,
    payload: JSON.stringify(envelope.data),
  };
}

function projectionSnapshot(runId: string) {
  return {
    run: runAsOf(runId),
    agents: db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM agents WHERE run_id = ? ORDER BY agent_id",
      )
      .all(runId),
    handles: db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM handles WHERE run_id = ? ORDER BY agent_id",
      )
      .all(runId),
    notify: db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM notify_subscriptions WHERE run_id = ? ORDER BY subscriber_id, on_agent_id",
      )
      .all(runId),
    inbox: db
      .query<Record<string, unknown>, [string]>("SELECT * FROM inbox WHERE run_id = ? ORDER BY seq")
      .all(runId),
  };
}

describe("fold equivalence", () => {
  test("a run rebuilt from the envelope stream matches one rebuilt from the rows", async () => {
    const { runId, rootAgentId } = await startRun({ spec: spec("root", { spawnDepth: 2 }) });
    const { agentId } = await spawnChild(runId, rootAgentId, { prompt: "work" });
    await until(async () => {
      const r = await call("GET", `/agents/${agentId}`);
      return r.body?.outcome ? r.body : null;
    }, "the child to settle");

    // The rows are the source of truth today, so they set the baseline.
    rebuild();
    const fromRows = projectionSnapshot(runId);

    // Now throw the projections away and rebuild from what the sinks saw instead.
    db.exec(
      "DELETE FROM agents; DELETE FROM handles; DELETE FROM notify_subscriptions; DELETE FROM inbox;",
    );
    const envelopes = persistedOnly(sink.events)
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.durable!.seq - b.durable!.seq);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) apply(asRow(envelope));
    const fromEnvelopes = projectionSnapshot(runId);

    expect(fromEnvelopes).toEqual(fromRows);

    // Leave the shared database as the rest of the suite expects to find it.
    rebuild();
  });

  test("every persisted envelope has a row with the same type and seq", async () => {
    const { runId } = await startRun();
    await until(async () => {
      const r = await call("GET", `/runs/${runId}`);
      return r.body?.agents?.length ? r.body : null;
    }, "the run to have an agent");

    const rows = readAllLedger().filter((r) => r.run_id === runId);
    const envelopes = persistedOnly(sink.events).filter((e) => e.runId === runId);
    const rowKeys = new Set(rows.map((r) => `${r.seq}:${r.event}`));
    for (const envelope of envelopes) {
      expect(rowKeys).toContain(`${envelope.durable!.seq}:${envelope.type}`);
    }
  });

  test("stream-only events reach the sink without a row", async () => {
    // A text delta is published but never persisted. A sink that only ever saw durable events
    // would be useless as an export path, so this is a real property, not an accident.
    const { runId, rootAgentId } = await startRun();
    const sandboxId = (await call("GET", `/agents/${rootAgentId}`)).body.sandboxId;
    fakeSdk.sandboxes.get(sandboxId)!.turn = {
      events: [{ type: "text", text: "thinking" }],
    };
    await call("POST", `/agents/${rootAgentId}/prompt`, { text: "go" });
    await until(
      async () => sink.events.find((e) => e.type === "message.updated") ?? null,
      "a streamed delta",
    );
    const delta = sink.events.find((e) => e.type === "message.updated")!;
    expect(delta.durable).toBeUndefined();
    expect(readAllLedger().some((r) => r.event === "message.updated")).toBe(false);
  });

  test("a throwing sink never fails the operation that emitted the event", async () => {
    // The whole reason sinks are composed and isolated: an export failing must not take out
    // the swarm it is exporting.
    clearSinks();
    addSink(() => {
      throw new Error("exporter down");
    });
    addSink(sink);
    const { runId } = await startRun();
    expect(readAllLedger().some((r) => r.run_id === runId)).toBe(true);
    expect(sink.events.some((e) => e.runId === runId)).toBe(true);
  });
});

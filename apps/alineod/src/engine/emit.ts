/**
 * The single path an event takes: append to the ledger → fold into the projections →
 * publish to the SSE bus. Every state change in alineod goes through here so the ledger
 * stays the source of truth.
 *
 * It now also builds a `LedgerEnvelope` for each event and hands it to the sinks. That is
 * strictly additive: the row, the projection call and the bus message are unchanged apart
 * from the event's name. A bug in this function is a bug in everything alineod does, so the
 * envelope is assembled from what the row already returned rather than computed a second way.
 */
import { getEvent, renamedEventType } from "@alineo-labs/schema";
import type { LedgerEnvelope } from "@alineo-labs/schema/types";
import { composeSinks, type EventSink } from "@alineo-labs/ledger";
import { getLogger } from "@alineo-labs/logger";
import { appendRow } from "../state/db";
import { apply } from "../state/projection";
import { publish } from "../bus";
import { logEvent, logHarnessEvent } from "./log";

const log = getLogger("alineod");

const sinks: EventSink[] = [];
let fanOut: EventSink = () => {};

/**
 * Attach a sink. Internal for now: under the durable-execution decision the ledger is the
 * system of record and a sink is an *export* path, so the public shape of this belongs with
 * the work that owns export, not here.
 *
 * @internal
 */
export function addSink(sink: EventSink): () => void {
  sinks.push(sink);
  fanOut = composeSinks(sinks, (error, envelope) =>
    log.warn("event sink failed", { type: envelope.type, error: String(error) }),
  );
  return () => {
    const at = sinks.indexOf(sink);
    if (at !== -1) sinks.splice(at, 1);
    fanOut = composeSinks(sinks, (error, envelope) =>
      log.warn("event sink failed", { type: envelope.type, error: String(error) }),
    );
  };
}

/** Test seam: drop every attached sink. @internal */
export function clearSinks(): void {
  sinks.length = 0;
  fanOut = () => {};
}

function envelope(
  type: string,
  ts: number,
  seq: number,
  runId: string,
  agentId: string | null,
  data: Record<string, unknown>,
): LedgerEnvelope {
  return {
    v: 1,
    ts,
    type,
    runId,
    ...(agentId ? { agentId } : {}),
    durable: {
      // The run is alineod's aggregate: `seq` is monotone within one, which is exactly what
      // SSE hands back as `Last-Event-ID`.
      aggregate: runId,
      seq,
      version: getEvent(type)?.version ?? 1,
    },
    data,
  };
}

/** Persist an alineod event and fan it out. Returns the assigned `seq`. */
export function emit(
  runId: string,
  agentId: string | null,
  event: string,
  payload: Record<string, unknown>,
): number {
  const data = { agentId, ...payload };
  const row = appendRow(runId, agentId, event, data);
  logEvent(runId, agentId, event, payload, row.seq);
  apply(row);
  publish(runId, { id: row.seq, event, data });
  fanOut(envelope(event, row.ts, row.seq, runId, agentId, data));
  for (const listener of listeners) listener(runId, agentId, event, payload);
  return row.seq;
}

type EmitListener = (
  runId: string,
  agentId: string | null,
  event: string,
  payload: Record<string, unknown>,
) => void;

const listeners: EmitListener[] = [];

/**
 * React to persisted alineod events across every run (the bus is per run). For engine modules
 * that trigger on a state change anywhere — e.g. notify.ts delivering on `agent.ended`. Runs
 * after the event is in the ledger and the projections.
 */
export function onEmit(listener: EmitListener): void {
  listeners.push(listener);
}

/**
 * Forwarded harness events (`message.updated`, `tool.started`, `turn.ended`, …). High-volume
 * ones (text deltas) stream but are not persisted; milestone ones are persisted so a
 * reconnecting subscriber can replay them (research/daemon.md §7).
 *
 * alineod is where the harness stream crosses into alineo's own vocabulary, so the incoming
 * `ev.type` is translated here. The SDK still emits the old flat names; once it emits the new
 * ones, `renamedEventType` simply stops matching and the name passes through unchanged — which
 * is why the translation is a lookup with a fallback rather than a branch on SDK version.
 */
const PERSISTED_HARNESS_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "compaction_end",
  "permission_request",
  "permission_resolved",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
]);

export function emitHarness(
  runId: string,
  agentId: string,
  ev: { type: string } & Record<string, unknown>,
): void {
  const { type: incoming, ...rest } = ev;
  const type = renamedEventType(incoming) ?? incoming;
  const data = { agentId, ...rest };
  // `PERSISTED_HARNESS_EVENTS` still decides, against the name the SDK sent. The definitions
  // say the same thing — scripts/check-vocabulary.ts fails the build if they ever diverge —
  // so this reads from the Set until the Set is deleted, rather than changing two things at
  // once in the function every alineod state change goes through.
  if (PERSISTED_HARNESS_EVENTS.has(incoming)) {
    const row = appendRow(runId, agentId, type, data);
    logHarnessEvent(runId, agentId, type, rest);
    apply(row); // no-op for harness events, but keeps the one-writer rule honest
    publish(runId, { id: row.seq, event: type, data });
    fanOut(envelope(type, row.ts, row.seq, runId, agentId, data));
  } else {
    publish(runId, { event: type, data });
    fanOut({
      v: 1,
      ts: Date.now(),
      type,
      runId,
      agentId,
      data,
    });
  }
}

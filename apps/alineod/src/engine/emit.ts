/**
 * The single path an event takes: append to the ledger → fold into the projections →
 * publish to the SSE bus. Every state change in alineod goes through here so the ledger
 * stays the source of truth.
 */
import { appendRow } from "../state/db";
import { apply } from "../state/projection";
import { publish } from "../bus";

/** Persist an alineod event and fan it out. Returns the assigned `seq`. */
export function emit(runId: string, agentId: string | null, event: string, payload: Record<string, unknown>): number {
  const row = appendRow(runId, agentId, event, { agentId, ...payload });
  apply(row);
  publish(runId, { id: row.seq, event, data: { agentId, ...payload } });
  return row.seq;
}

/**
 * Forwarded harness events (`text`, `tool_start`, `turn_end`, …). High-volume ones (text
 * deltas) stream but are not persisted; milestone ones are persisted so a reconnecting
 * subscriber can replay them (research/daemon.md §7).
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

export function emitHarness(runId: string, agentId: string, ev: { type: string } & Record<string, unknown>): void {
  const { type, ...rest } = ev;
  const data = { agentId, ...rest };
  if (PERSISTED_HARNESS_EVENTS.has(type)) {
    const row = appendRow(runId, agentId, type, data);
    apply(row); // no-op for harness events, but keeps the one-writer rule honest
    publish(runId, { id: row.seq, event: type, data });
  } else {
    publish(runId, { event: type, data });
  }
}

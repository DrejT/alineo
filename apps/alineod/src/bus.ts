/**
 * In-process pub/sub for SSE fan-out, keyed by `runId`. One `EventEmitter` per run.
 *
 * Prototype scope: single process, no cross-instance fan-out. A real deployment would put a
 * durable log / broker here — but the ledger replay in routes/events.ts already covers
 * reconnect-after-restart for persisted events, so a subscriber never depends on the bus for
 * correctness, only for liveness.
 */
import { EventEmitter } from "node:events";

/** What a subscriber receives. `id` is the ledger `seq` for persisted events, absent otherwise. */
export interface BusMessage {
  id?: number;
  event: string;
  data: unknown;
}

const emitters = new Map<string, EventEmitter>();

function emitterFor(runId: string): EventEmitter {
  let e = emitters.get(runId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0); // many SSE subscribers per run is expected
    emitters.set(runId, e);
  }
  return e;
}

export function publish(runId: string, msg: BusMessage): void {
  emitterFor(runId).emit("msg", msg);
}

/** Register a listener. Returns an unsubscribe function. */
export function onRun(runId: string, fn: (msg: BusMessage) => void): () => void {
  const e = emitterFor(runId);
  e.on("msg", fn);
  return () => e.off("msg", fn);
}

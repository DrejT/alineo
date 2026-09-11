/**
 * `GET /runs/:runId/events` — one Server-Sent Events stream carrying the whole swarm:
 * alineod's `agent_*` lifecycle events plus every live agent's forwarded harness events,
 * each tagged with `agentId`.
 *
 * Reconnect: honours `Last-Event-ID` (the ledger `seq`). Persisted events after that seq are
 * replayed from the ledger before the live subscription attaches; unpersisted text deltas in
 * the gap are lost, which is acceptable — they are ephemeral.
 */
import { readLedgerSince } from "../state/db";
import { onRun, type BusMessage } from "../bus";
import { SSE_HEARTBEAT_MS } from "../../config";

// D-e: backpressure. A subscriber that stops reading makes Bun's ReadableStream queue grow
// unbounded internally. Ephemeral messages (no `id`, e.g. text deltas) are safe to drop —
// nothing replays them anyway. Persisted messages are never dropped, but if the connection
// stays backed up for this many of them in a row, force-close it: the ledger has every
// persisted event, so a reconnect with `Last-Event-ID` picks up exactly where it left off —
// cheaper than an unbounded per-connection buffer.
const BACKPRESSURE_PERSISTED_LIMIT = 500;

function frame(id: number | undefined, event: string, data: unknown): string {
  const lines = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id !== undefined) lines.unshift(`id: ${id}`);
  return lines.join("\n") + "\n\n";
}

export function sseResponse(runId: string, lastEventId: number): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  let backedUpPersistedCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string, persisted: boolean) => {
        const backedUp = controller.desiredSize !== null && controller.desiredSize <= 0;
        if (backedUp) {
          if (!persisted) return; // ephemeral — drop, no replay obligation
          if (++backedUpPersistedCount > BACKPRESSURE_PERSISTED_LIMIT) {
            cleanup(); // force a reconnect; Last-Event-ID replay covers the gap
            return;
          }
        } else {
          backedUpPersistedCount = 0;
        }
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };

      // 1. replay persisted rows since the client's last seen seq
      for (const row of readLedgerSince(runId, lastEventId)) {
        const payload = row.payload ? JSON.parse(row.payload) : {};
        send(frame(row.seq, row.event, payload), true);
      }

      // 2. live subscription
      const off = onRun(runId, (msg: BusMessage) => send(frame(msg.id, msg.event, msg.data), msg.id !== undefined));

      // 3. keep-alive
      const hb = setInterval(() => send(`: ping\n\n`, false), SSE_HEARTBEAT_MS);

      cleanup = () => {
        off();
        clearInterval(hb);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

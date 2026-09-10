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

function frame(id: number | undefined, event: string, data: unknown): string {
  const lines = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id !== undefined) lines.unshift(`id: ${id}`);
  return lines.join("\n") + "\n\n";
}

export function sseResponse(runId: string, lastEventId: number): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };

      // 1. replay persisted rows since the client's last seen seq
      for (const row of readLedgerSince(runId, lastEventId)) {
        const payload = row.payload ? JSON.parse(row.payload) : {};
        send(frame(row.seq, row.event, payload));
      }

      // 2. live subscription
      const off = onRun(runId, (msg: BusMessage) => send(frame(msg.id, msg.event, msg.data)));

      // 3. keep-alive
      const hb = setInterval(() => send(`: ping\n\n`), SSE_HEARTBEAT_MS);

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

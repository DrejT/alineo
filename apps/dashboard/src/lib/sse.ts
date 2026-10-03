/** Subscribes to `GET /runs/:runId/events` — alineod's single SSE stream for a whole swarm. */
const BASE = import.meta.env.PUBLIC_ALINEOD_URL ?? "/api";

export interface SwarmEvent {
  seq?: number;
  event: string;
  data: Record<string, unknown>;
}

/**
 * Manual SSE parse over `fetch` rather than `EventSource` — alineod names every frame's
 * `event:` field after the alineod/harness event type (`agent.spawned`, `tool.started`, ...),
 * and `EventSource` has no wildcard listener, only per-name `addEventListener`, which would
 * require knowing every event name in advance.
 */
export function watchRun(runId: string, onEvent: (ev: SwarmEvent) => void): () => void {
  const controller = new AbortController();
  let lastEventId = 0;

  async function connect(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`${BASE}/runs/${runId}/events`, {
          signal: controller.signal,
          headers: lastEventId ? { "Last-Event-ID": String(lastEventId) } : {},
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) parseFrame(frame);
        }
      } catch {
        // network error / abort — fall through to reconnect unless aborted
      }
      if (controller.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function parseFrame(frame: string): void {
    let event = "message";
    let data = "";
    let id: number | undefined;
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
      else if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    }
    if (!data) return;
    if (id !== undefined) lastEventId = id;
    try {
      onEvent({ seq: id, event, data: JSON.parse(data) });
    } catch {
      // malformed frame — ignore
    }
  }

  void connect();
  return () => controller.abort();
}

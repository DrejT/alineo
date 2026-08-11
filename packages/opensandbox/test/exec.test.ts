import { describe, expect, it, vi, afterEach } from "vitest";
import { ExecClient } from "../src/exec.ts";
import { SSEEventType } from "../src/types.ts";

/**
 * Builds a fetch Response backed by a stream that emits the given SSE events and then
 * — deliberately, like execd's real post-completion sleep (OpenSandbox#1277) — does NOT
 * close on its own. `cancel` lets a test assert whether/when the client tears it down.
 */
function sseResponse(events: object[], cancel: () => void) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n\n`));
    },
    cancel,
  });
  return { ok: true, status: 200, body: stream, text: async () => "" };
}

describe("ExecClient exec streams", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executeCommand() resolves on the terminal event without cancelling the stream", async () => {
    const cancel = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([{ type: SSEEventType.ExecutionComplete }], cancel));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ExecClient({ baseUrl: "http://localhost:44772", accessToken: "" });
    const events = [];
    for await (const ev of client.executeCommand({ command: "true" })) events.push(ev);

    expect(events).toEqual([{ type: SSEEventType.ExecutionComplete }]);
    // Matches the deliberate choice in parseSSE: don't abort the connection the instant
    // the terminal event arrives, to dodge OpenSandbox#1277's proxy relay error.
    expect(cancel).not.toHaveBeenCalled();
  });

  it("disposeConnections() force-cancels a stream left dangling by the terminal-event early return", async () => {
    const cancel = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([{ type: SSEEventType.ExecutionComplete }], cancel));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ExecClient({ baseUrl: "http://localhost:44772", accessToken: "" });
    for await (const _ev of client.executeCommand({ command: "true" })) {
      // drain
    }
    expect(cancel).not.toHaveBeenCalled();

    client.disposeConnections();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("disposeConnections() is a no-op for a stream that already reached natural EOF", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    // watchMetrics() passes no isTerminal predicate, so parseSSE only stops via `done` —
    // simulate the server actually closing the connection this time.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: SSEEventType.Status })}\n\n`));
        controller.close();
      },
      cancel,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: stream, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const client = new ExecClient({ baseUrl: "http://localhost:44772", accessToken: "" });
    const events = [];
    for await (const ev of client.watchMetrics()) events.push(ev);
    expect(events).toEqual([{ type: SSEEventType.Status }]);

    client.disposeConnections();
    // The reader was released (not registered as pending) once `done` was reached
    // naturally, so this must be a no-op rather than double-cancelling anything.
    expect(cancel).not.toHaveBeenCalled();
  });
});

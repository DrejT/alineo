import { describe, expect, it, vi, afterEach } from "vitest";
import { ExecClient, MAX_COMMAND_BYTES } from "../src/exec.ts";
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

describe("ExecClient failures carry an alineo code", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const failing = (status: number, text: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => text }),
    );
  const client = () => new ExecClient({ baseUrl: "http://localhost:44772", accessToken: "" });

  it("a command on a sandbox the server no longer has is SANDBOX_NOT_FOUND", async () => {
    failing(
      404,
      JSON.stringify({ code: "DOCKER::SANDBOX_NOT_FOUND", message: "Sandbox sb-1 not found." }),
    );

    const err = await (async () => {
      for await (const _ev of client().executeCommand({ command: "true" })) {
        // never yields
      }
    })().catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: "SANDBOX_NOT_FOUND",
      status: 404,
      upstreamCode: "DOCKER::SANDBOX_NOT_FOUND",
    });
  });

  it("a file download that fails keeps the status in the message when the body is empty", async () => {
    failing(500, "");

    const err = await client()
      .downloadFile("/etc/hostname")
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 500 });
    expect((err as Error).message).toBe("execd error 500");
  });

  it("a plain-text error body is kept as the message", async () => {
    failing(429, "slow down");

    const err = await client()
      .uploadFile("/tmp/x", new Uint8Array([1]))
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 429, message: "slow down" });
  });
});

describe("ExecClient command size guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (command: string) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ExecClient({ baseUrl: "http://localhost:44772", accessToken: "" });
    return {
      fetchMock,
      done: (async () => {
        for await (const _ev of client.executeCommand({ command })) {
          // no events
        }
      })().catch((e: unknown) => e),
    };
  };

  it("refuses a command over the limit before any request, with INVALID_ARGUMENT and a hint", async () => {
    const { fetchMock, done } = run("x".repeat(MAX_COMMAND_BYTES + 1));
    const err = await done;
    expect(err).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((err as { hint?: string }).hint).toContain("writeFile");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts bytes, not characters", async () => {
    const { done } = run("é".repeat(MAX_COMMAND_BYTES / 2 + 1));
    expect(await done).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("sends a command at the limit", async () => {
    const { fetchMock, done } = run("x".repeat(MAX_COMMAND_BYTES));
    expect(await done).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, afterEach } from "bun:test";
import type { SandboxHandle } from "@alineo-labs/core";
import { PiAdapter } from "../src/adapters/pi";
import { PromptTimeoutError } from "../src/errors";

// The bridge's own `: ping\n\n` heartbeat (every 3s in production, see pi-bridge.js) keeps the
// SSE connection's raw `reader.read()` resolving regardless of whether Pi itself is making any
// real progress. These tests simulate that directly -- a fetch mock streaming only heartbeat
// comment lines, or a mix of heartbeats and real events -- to verify the inactivity timeout is
// keyed off real `AgentEvent`s, not raw stream activity.

function fakeSandbox(): SandboxHandle {
  return {
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    proxy: (_port: number) => Promise.resolve({ url: "http://fake-bridge", headers: {} }),
  } as unknown as SandboxHandle;
}

async function adapterWithBridge(): Promise<PiAdapter> {
  const adapter = new PiAdapter();
  await adapter.startBridge(fakeSandbox());
  return adapter;
}

function sseResponse(chunks: string[], opts: { intervalMs: number; keepOpenAfter?: boolean }) {
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const push = () => {
        if (stopped) return;
        if (i < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[i]));
          i++;
          setTimeout(push, opts.intervalMs);
        } else if (!opts.keepOpenAfter) {
          controller.close();
        } else {
          // Leave the stream open (simulates a genuinely stuck connection with a still-alive
          // heartbeat, which is exactly what should trip the inactivity timeout) but keep
          // pushing heartbeats so a real consumer would see ongoing raw activity -- stops once
          // `cancel()` fires below, so it doesn't outlive the test that started it.
          setTimeout(push, opts.intervalMs);
        }
      };
      push();
    },
    cancel() {
      stopped = true;
    },
  });
  return new Response(stream, { status: 200 });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("PiAdapter.prompt inactivity timeout", () => {
  it("times out when only heartbeat pings arrive, never a real event", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        sseResponse(Array(50).fill(": ping\n\n"), { intervalMs: 10, keepOpenAfter: true }),
      )) as unknown as typeof fetch;

    const adapter = await adapterWithBridge();
    const stream = adapter.prompt("hi", { inactivityTimeoutMs: 80 });

    await expect(
      (async () => {
        for await (const _ev of stream) {
          // draining -- should never yield anything before the timeout fires
        }
      })(),
    ).rejects.toThrow(PromptTimeoutError);
  });

  it("does not time out while real events keep arriving faster than the window", async () => {
    const chunks = [
      ": ping\n\n",
      'data: {"type":"text","text":"a"}\n\n',
      ": ping\n\n",
      'data: {"type":"text","text":"b"}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(chunks, { intervalMs: 20 }))) as unknown as typeof fetch;

    const adapter = await adapterWithBridge();
    const stream = adapter.prompt("hi", { inactivityTimeoutMs: 200 });

    const texts: string[] = [];
    for await (const ev of stream) {
      if (ev.type === "text") texts.push(ev.text);
    }
    expect(texts).toEqual(["a", "b"]);
  });
});

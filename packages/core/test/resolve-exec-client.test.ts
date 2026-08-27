import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveExecClient } from "../src/sandbox/resolve.ts";
import { ExecConnectionError } from "../src/errors.ts";
import type { ControlClient } from "@alineo-labs/opensandbox";

function makeControl(): ControlClient {
  return {
    getEndpoint: vi.fn().mockResolvedValue({ endpoint: "http://localhost:44772", headers: {} }),
  } as unknown as ControlClient;
}

describe("resolveExecClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries through transient failures and succeeds once execd accepts connections, using the real default budget", async () => {
    // Real defaults (~80s of patience) apply since retries/delayMs aren't overridden here --
    // this only takes as long as the two failures' own small ramp-up delays (100ms, 150ms).
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("ECONNREFUSED"));
        // eslint-disable-next-line typescript/require-await -- must match fetch's Response.json() signature; nothing here needs to await
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }),
    );

    const client = await resolveExecClient(makeControl(), "sb-1");
    expect(client).toBeDefined();
    expect(calls).toBe(3);
  });

  it("throws ExecConnectionError once the retry budget is exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Small explicit budget here purely to keep this test fast -- the exhaustion behavior
    // itself doesn't depend on the specific numbers, only on eventually giving up.
    await expect(resolveExecClient(makeControl(), "sb-1", undefined, 2, 5)).rejects.toThrow(
      ExecConnectionError,
    );
  });

  it("affords substantially more patience than before issue #32 (the old ~11s/16-attempt budget)", async () => {
    // Fake timers fast-forward every setTimeout the retry loop schedules instantly, so this
    // exercises the REAL default retry math (up to 45 real retries with real backoff) without
    // any actual wall-clock delay -- succeeding on attempt 40 is well past the old ceiling of
    // 16 total attempts, proving the new default budget is substantially larger.
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls < 40) return Promise.reject(new Error("ECONNREFUSED"));
        // eslint-disable-next-line typescript/require-await -- must match fetch's Response.json() signature; nothing here needs to await
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }),
    );

    const promise = resolveExecClient(makeControl(), "sb-1");
    await vi.runAllTimersAsync();
    const client = await promise;
    expect(client).toBeDefined();
    expect(calls).toBe(40);
  });
});

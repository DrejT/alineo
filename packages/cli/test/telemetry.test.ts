import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envDisabled,
  isTelemetryDisabled,
  readTelemetryConfig,
  sendTelemetryEvent,
  withTelemetry,
  writeTelemetryConfig,
} from "../src/telemetry.js";

let originalConfigPath: string | undefined;
let originalDisabled: string | undefined;
let originalDoNotTrack: string | undefined;
let originalFetch: typeof fetch;
let tempDir: string;

beforeEach(async () => {
  originalConfigPath = process.env.ALINEO_TELEMETRY_CONFIG_PATH;
  originalDisabled = process.env.ALINEO_TELEMETRY_DISABLED;
  originalDoNotTrack = process.env.DO_NOT_TRACK;
  originalFetch = globalThis.fetch;
  delete process.env.ALINEO_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  // `node:os`'s `homedir()` doesn't re-read `process.env.HOME` after its first call in a
  // process, so isolation goes through `telemetry.ts`'s own internal test seam instead -- see
  // that file's `telemetryConfigPath()` doc comment.
  tempDir = await mkdtemp(join(tmpdir(), "alineo-telemetry-test-"));
  process.env.ALINEO_TELEMETRY_CONFIG_PATH = join(tempDir, "telemetry.json");
});

afterEach(async () => {
  if (originalConfigPath === undefined) delete process.env.ALINEO_TELEMETRY_CONFIG_PATH;
  else process.env.ALINEO_TELEMETRY_CONFIG_PATH = originalConfigPath;
  if (originalDisabled === undefined) delete process.env.ALINEO_TELEMETRY_DISABLED;
  else process.env.ALINEO_TELEMETRY_DISABLED = originalDisabled;
  if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = originalDoNotTrack;
  globalThis.fetch = originalFetch;
  mock.restore();
  await rm(tempDir, { recursive: true, force: true });
});

describe("envDisabled / isTelemetryDisabled", () => {
  it("is disabled by default (no config file yet)", async () => {
    expect(await isTelemetryDisabled()).toBe(true);
  });

  it("ALINEO_TELEMETRY_DISABLED disables regardless of persisted config", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: null });
    process.env.ALINEO_TELEMETRY_DISABLED = "1";
    expect(envDisabled()).toBe(true);
    expect(await isTelemetryDisabled()).toBe(true);
  });

  it("DO_NOT_TRACK disables regardless of persisted config", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: null });
    process.env.DO_NOT_TRACK = "1";
    expect(envDisabled()).toBe(true);
    expect(await isTelemetryDisabled()).toBe(true);
  });

  it("is enabled once the persisted config says so, with no env var set", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: null });
    expect(await isTelemetryDisabled()).toBe(false);
  });
});

describe("readTelemetryConfig / writeTelemetryConfig", () => {
  it("round-trips a written config", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "abc-123", notifiedAt: 42 });
    const config = await readTelemetryConfig();
    expect(config).toEqual({ enabled: true, anonymousId: "abc-123", notifiedAt: 42 });
  });

  it("generates a fresh anonymousId when no config file exists yet", async () => {
    const config = await readTelemetryConfig();
    expect(config.enabled).toBe(false);
    expect(config.anonymousId.length).toBeGreaterThan(0);
    expect(config.notifiedAt).toBeNull();
  });
});

describe("sendTelemetryEvent", () => {
  const event = {
    command: "spawn",
    flags: { json: true },
    outcome: "success" as const,
    durationMs: 10,
    cliVersion: "0.0.0",
    osPlatform: "linux",
    osArch: "x64",
    bunVersion: "1.0.0",
    isCI: false,
    anonymousId: "abc",
  };

  it("never throws when fetch rejects", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof fetch;
    await expect(
      sendTelemetryEvent(event, "http://example.invalid/v1/events"),
    ).resolves.toBeUndefined();
  });

  it("never throws and does not hang when fetch never resolves", async () => {
    // A hanging real request still rejects once its AbortSignal fires -- this mock has to
    // honor that same contract to actually exercise sendTelemetryEvent's own timeout bound
    // (a mock that ignores `init.signal` entirely would hang regardless of what the
    // implementation does, proving nothing about its timeout logic).
    globalThis.fetch = mock(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const start = performance.now();
    await sendTelemetryEvent(event, "http://example.invalid/v1/events");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("POSTs the event as JSON to the given endpoint", async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    await sendTelemetryEvent(event, "http://example.invalid/v1/events");
    expect(capturedUrl).toBe("http://example.invalid/v1/events");
    expect(JSON.parse(capturedBody ?? "{}")).toEqual(event);
  });
});

describe("withTelemetry", () => {
  it("calls run() directly when telemetry is disabled, without ever touching fetch", async () => {
    const fetchSpy = mock(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    let ran = false;
    await withTelemetry("spawn", [], async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-throws the original error after recording outcome: error", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    const boom = new Error("boom");
    await expect(
      withTelemetry("spawn", [], async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const sent = JSON.parse(capturedBody ?? "{}");
    expect(sent.outcome).toBe("error");
    expect(sent.errorClass).toBe("Error");
  });

  it("only reports allowlisted flags for the given command, dropping everything else", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    // "agents" only allowlists --json; --not-a-real-flag must never appear in the sent event.
    await withTelemetry("agents", ["--json", "--not-a-real-flag"], async () => {});

    const sent = JSON.parse(capturedBody ?? "{}");
    expect(sent.flags).toEqual({ json: true });
  });

  it("prints the first-run notice exactly once, on the first send", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: null });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    ) as unknown as typeof fetch;

    const originalError = console.error;
    const messages: unknown[] = [];
    console.error = (...args: unknown[]) => messages.push(args);
    try {
      await withTelemetry("agents", [], async () => {});
      await withTelemetry("agents", [], async () => {});
    } finally {
      console.error = originalError;
    }

    const noticeCount = messages.filter((m) =>
      String(m).includes("Anonymous usage telemetry"),
    ).length;
    expect(noticeCount).toBe(1);

    const config = await readTelemetryConfig();
    expect(config.notifiedAt).not.toBeNull();
  });
});

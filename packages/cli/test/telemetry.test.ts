import { AlineoError } from "@alineo-labs/errors";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envDisabled,
  extractSpecProvider,
  isTelemetryDisabled,
  readTelemetryConfig,
  sendTelemetryEvent,
  withTelemetry,
  writeTelemetryConfig,
  type CliTelemetryEvent,
} from "../src/telemetry.js";
import { stubFetch } from "./fetch-stub.ts";

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
  it("is enabled by default (no config file yet)", async () => {
    expect(await isTelemetryDisabled()).toBe(false);
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

  it("is disabled once the persisted config explicitly opts out, with no env var set", async () => {
    await writeTelemetryConfig({ enabled: false, anonymousId: "x", notifiedAt: null });
    expect(await isTelemetryDisabled()).toBe(true);
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
    expect(config.enabled).toBe(true);
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
    globalThis.fetch = stubFetch(() => Promise.reject(new Error("network down")));
    // bun-types types `.resolves`/`.rejects` as Matchers<unknown>, whose assertion methods
    // return void — the actual async runtime behavior isn't reflected in the type.
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression
    await expect(
      sendTelemetryEvent(event, "http://example.invalid/v1/events"),
    ).resolves.toBeUndefined();
  });

  it("never throws and does not hang when fetch never resolves", async () => {
    // A hanging real request still rejects once its AbortSignal fires -- this mock has to
    // honor that same contract to actually exercise sendTelemetryEvent's own timeout bound
    // (a mock that ignores `init.signal` entirely would hang regardless of what the
    // implementation does, proving nothing about its timeout logic).
    globalThis.fetch = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const start = performance.now();
    await sendTelemetryEvent(event, "http://example.invalid/v1/events");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("POSTs the event as JSON to the given endpoint", async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = stubFetch((url, init) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await sendTelemetryEvent(event, "http://example.invalid/v1/events");
    expect(capturedUrl).toBe("http://example.invalid/v1/events");
    expect(JSON.parse(capturedBody ?? "{}")).toEqual(event);
  });
});

describe("withTelemetry", () => {
  it("calls run() directly when telemetry is disabled, without ever touching fetch", async () => {
    await writeTelemetryConfig({ enabled: false, anonymousId: "x", notifiedAt: Date.now() });
    const fetchSpy = stubFetch(() => {
      throw new Error("should not be called");
    });
    globalThis.fetch = fetchSpy;
    let ran = false;
    // eslint-disable-next-line typescript/require-await -- run must return a Promise per withTelemetry's signature; nothing here needs to await
    await withTelemetry("spawn", [], async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-throws the original error after recording outcome: error", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = stubFetch((_url, init) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const boom = new Error("boom");
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- see comment on the earlier .resolves. usage above
    await expect(
      // eslint-disable-next-line typescript/require-await -- run must return a Promise per withTelemetry's signature; nothing here needs to await
      withTelemetry("spawn", [], async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const sent = JSON.parse(capturedBody ?? "{}") as CliTelemetryEvent;
    expect(sent.outcome).toBe("error");
    expect(sent.errorClass).toBe("Error");
  });

  it("reports the alineo error code, not the class name, when the error has one", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = stubFetch((_url, init) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- see comment on the earlier .resolves. usage above
    await expect(
      // eslint-disable-next-line typescript/require-await -- run must return a Promise per withTelemetry's signature; nothing here needs to await
      withTelemetry("spawn", [], async () => {
        throw new AlineoError("EXEC_NOT_READY", "execd not ready for sandbox sb-1");
      }),
    ).rejects.toThrow("execd not ready");

    const sent = JSON.parse(capturedBody ?? "{}") as CliTelemetryEvent;
    expect(sent.outcome).toBe("error");
    expect(sent.errorClass).toBe("EXEC_NOT_READY");
  });

  it("only reports allowlisted flags for the given command, dropping everything else", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = stubFetch((_url, init) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    // "agents" only allowlists --json; --not-a-real-flag must never appear in the sent event.
    await withTelemetry("agents", ["--json", "--not-a-real-flag"], async () => {});

    const sent = JSON.parse(capturedBody ?? "{}") as CliTelemetryEvent;
    expect(sent.flags).toEqual({ json: true });
  });

  it("prints the first-run notice exactly once, on the first send", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: null });
    globalThis.fetch = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));

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

describe("extractSpecProvider", () => {
  async function spec(name: string, body: unknown): Promise<string> {
    const path = join(tempDir, name);
    await writeFile(path, JSON.stringify(body));
    return path;
  }

  it("reads the provider of the spec given to start", async () => {
    const path = await spec("a.json", { name: "a", provider: "nvidia" });
    expect(await extractSpecProvider("start", [path])).toBe("nvidia");
  });

  it("prefers model.provider, where the field moved to", async () => {
    const path = await spec("b.json", { name: "b", model: { provider: "google", id: "x" } });
    expect(await extractSpecProvider("start", [path])).toBe("google");
  });

  it("finds the spec past leading flags, as start does", async () => {
    const path = await spec("c.json", { name: "c", provider: "nvidia" });
    expect(await extractSpecProvider("start", ["--json", path, "--prompt", "hi"])).toBe("nvidia");
  });

  it("reads the child spec of spawn, not the parent id", async () => {
    const path = await spec("d.json", { name: "d", provider: "nvidia" });
    expect(await extractSpecProvider("spawn", ["1d2acd80-parent-sandbox-id", path])).toBe("nvidia");
    expect(await extractSpecProvider("spawn", ["1d2acd80-parent-sandbox-id"])).toBeUndefined();
  });

  it("sends nothing for other commands, including the retired fork", async () => {
    const path = await spec("e.json", { name: "e", provider: "nvidia" });
    for (const command of ["fork", "prompt", "add", "list", "stop"]) {
      expect(await extractSpecProvider(command, [path])).toBeUndefined();
      expect(await extractSpecProvider(command, ["parent", path])).toBeUndefined();
    }
  });

  it("never throws on a missing, unreadable or provider-less spec", async () => {
    expect(await extractSpecProvider("start", [join(tempDir, "missing.json")])).toBeUndefined();
    const bad = join(tempDir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await extractSpecProvider("start", [bad])).toBeUndefined();
    const none = await spec("none.json", { name: "none" });
    expect(await extractSpecProvider("start", [none])).toBeUndefined();
    const num = await spec("num.json", { provider: 7 });
    expect(await extractSpecProvider("start", [num])).toBeUndefined();
    expect(await extractSpecProvider("start", [])).toBeUndefined();
  });

  it("reaches the event body through withTelemetry for start", async () => {
    await writeTelemetryConfig({ enabled: true, anonymousId: "x", notifiedAt: Date.now() });
    let capturedBody: string | undefined;
    globalThis.fetch = stubFetch((_url, init) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const path = await spec("f.json", { name: "f", provider: "nvidia" });
    // eslint-disable-next-line typescript/require-await -- run must return a Promise per withTelemetry's signature; nothing here needs to await
    await withTelemetry("start", [path], async () => {});
    expect((JSON.parse(capturedBody ?? "{}") as CliTelemetryEvent).specProvider).toBe("nvidia");
  });
});

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "alineo-telemetry-posthog-test-"));
process.env.TELEMETRY_DB_PATH = join(dir, "telemetry.db");

const { postEvent } = await import("../routes/events");
const { firstSeenAt } = await import("../db");
const {
  EXCEPTION_EVENT,
  RUN_EVENT,
  compileDenyList,
  createForwarder,
  isInternalAddress,
  tenureBucket,
  toPostHogEvents,
} = await import("../posthog");
import type { ForwarderOptions } from "../posthog";
import type { CliTelemetryEvent } from "../db";

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function cliEvent(overrides: Partial<CliTelemetryEvent> = {}): CliTelemetryEvent {
  return {
    command: "spawn",
    flags: { json: true },
    outcome: "success",
    durationMs: 120,
    cliVersion: "0.4.0",
    osPlatform: "linux",
    osArch: "x64",
    bunVersion: "1.3.9",
    isCI: false,
    anonymousId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

interface Call {
  url: string;
  body: { api_key: string; batch: Array<Record<string, any>> };
}

function recorder(respond: () => Response | Promise<Response> = () => new Response("{}")) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

function forwarderWith(overrides: Partial<ForwarderOptions> = {}) {
  return createForwarder({
    key: "phc_test",
    host: "https://us.i.posthog.com/",
    deny: [],
    internalIds: new Set(),
    dailyCap: 500,
    batchSize: 20,
    flushIntervalMs: 60_000,
    timeoutMs: 1_000,
    retryDelayMs: 1,
    now: () => NOW,
    log: () => {},
    ...overrides,
  });
}

const input = (event: CliTelemetryEvent, firstSeen: number | null = null) => ({
  event,
  receivedAt: NOW,
  firstSeenAt: firstSeen,
});

describe("toPostHogEvents", () => {
  const ctx = { receivedAt: NOW, firstSeenAt: NOW - 2 * DAY, internalIds: new Set<string>() };

  it("maps a success to one run event using only allowlisted fields", () => {
    const [run, ...rest] = toPostHogEvents(cliEvent({ specProvider: "nvidia" }), ctx);
    expect(rest).toHaveLength(0);
    expect(run!.event).toBe(RUN_EVENT);
    expect(run!.distinct_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(run!.timestamp).toBe(new Date(NOW).toISOString());
    expect(Object.keys(run!.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$lib",
        "bun_version",
        "cli_version",
        "command",
        "duration_ms",
        "flags",
        "internal",
        "is_ci",
        "os_arch",
        "os_platform",
        "outcome",
        "schema_version",
        "spec_provider",
        "tenure_bucket",
      ].sort(),
    );
    expect(run!.properties.$geoip_disable).toBe(true);
    expect(run!.properties).not.toHaveProperty("$ip");
  });

  it("adds a fingerprinted $exception for an error outcome", () => {
    const events = toPostHogEvents(
      cliEvent({ outcome: "error", errorClass: "ExecConnectionError" }),
      ctx,
    );
    expect(events.map((e) => e.event)).toEqual([RUN_EVENT, EXCEPTION_EVENT]);
    const exception = events[1]!;
    expect(exception.properties.$exception_fingerprint).toBe("spawn:ExecConnectionError");
    expect(exception.properties.$issue_name).toBe("spawn: ExecConnectionError");
    const list = exception.properties.$exception_list as Array<Record<string, unknown>>;
    expect(list[0]!.type).toBe("ExecConnectionError");
    expect(list[0]).not.toHaveProperty("stacktrace");
    expect(events[0]!.properties.error_class).toBe("ExecConnectionError");
  });

  it("falls back to UnknownError when the CLI sent no class", () => {
    const events = toPostHogEvents(cliEvent({ outcome: "error" }), ctx);
    expect(events[1]!.properties.$exception_fingerprint).toBe("spawn:UnknownError");
  });

  it("marks internal ids", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const internal = toPostHogEvents(cliEvent(), { ...ctx, internalIds: new Set([id]) });
    const external = toPostHogEvents(cliEvent({ anonymousId: "other" }), {
      ...ctx,
      internalIds: new Set([id]),
    });
    expect(internal[0]!.properties.internal).toBe(true);
    expect(external[0]!.properties.internal).toBe(false);
  });
});

describe("tenureBucket", () => {
  it("buckets by days since first seen", () => {
    expect(tenureBucket(null, NOW)).toBe("day_1");
    expect(tenureBucket(NOW - 0.5 * DAY, NOW)).toBe("day_1");
    expect(tenureBucket(NOW - 3 * DAY, NOW)).toBe("week_1");
    expect(tenureBucket(NOW - 10 * DAY, NOW)).toBe("month_1");
    expect(tenureBucket(NOW - 45 * DAY, NOW)).toBe("month_3");
    expect(tenureBucket(NOW - 200 * DAY, NOW)).toBe("older");
  });
});

describe("compileDenyList", () => {
  it("matches exact names and prefixes, case-insensitively", () => {
    const denied = compileDenyList([" Skills ", "ao.render*", ""]);
    expect(denied("skills")).toBe(true);
    expect(denied("SKILLS")).toBe(true);
    expect(denied("ao.renderer.loaded")).toBe(true);
    expect(denied("spawn")).toBe(false);
  });

  it("denies nothing for an empty list", () => {
    expect(compileDenyList([])("anything")).toBe(false);
  });
});

describe("createForwarder", () => {
  it("never calls fetch when the key is unset", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ key: "", fetch: fakeFetch });
    f.forward(input(cliEvent()));
    await f.flush();
    expect(calls).toHaveLength(0);
  });

  it("sends one batch to the batch endpoint with the project key", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch });
    f.forward(input(cliEvent()));
    f.forward(input(cliEvent({ outcome: "error", errorClass: "Error" })));
    await f.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/batch/");
    expect(calls[0]!.body.api_key).toBe("phc_test");
    expect(calls[0]!.body.batch.map((e) => e.event)).toEqual([
      RUN_EVENT,
      RUN_EVENT,
      EXCEPTION_EVENT,
    ]);
  });

  it("flushes on its own when the batch size is reached", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, batchSize: 2 });
    f.forward(input(cliEvent()));
    f.forward(input(cliEvent()));
    await Bun.sleep(5);
    expect(calls).toHaveLength(1);
  });

  it("skips denied commands and denied event names", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, deny: ["skills", EXCEPTION_EVENT] });
    f.forward(input(cliEvent({ command: "skills" })));
    f.forward(input(cliEvent({ command: "start", outcome: "error", errorClass: "Error" })));
    await f.flush();
    const names = calls.flatMap((c) => c.body.batch.map((e) => e.event));
    expect(names).toEqual([RUN_EVENT]);
  });

  it("drops events past the daily cap per command and outcome, and counts an error pair once", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, dailyCap: 2 });
    for (let i = 0; i < 4; i++) f.forward(input(cliEvent({ outcome: "error", errorClass: "E" })));
    f.forward(input(cliEvent({ command: "start" })));
    await f.flush();
    const batch = calls.flatMap((c) => c.body.batch);
    // 2 allowed error pairs (4 events) + 1 success for another command.
    expect(batch).toHaveLength(5);
    expect(batch.filter((e) => e.event === EXCEPTION_EVENT)).toHaveLength(2);
  });

  it("resets the cap at the next UTC day", async () => {
    const { calls, fakeFetch } = recorder();
    let now = NOW;
    const f = forwarderWith({ fetch: fakeFetch, dailyCap: 1, now: () => now });
    f.forward(input(cliEvent()));
    f.forward(input(cliEvent()));
    now += DAY;
    f.forward(input(cliEvent()));
    await f.flush();
    expect(calls.flatMap((c) => c.body.batch)).toHaveLength(2);
  });

  it("retries once on a 5xx, then gives up without throwing", async () => {
    const { calls, fakeFetch } = recorder(() => new Response("no", { status: 503 }));
    const f = forwarderWith({ fetch: fakeFetch });
    f.forward(input(cliEvent()));
    await f.flush();
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const { calls, fakeFetch } = recorder(() => new Response("bad key", { status: 401 }));
    const f = forwarderWith({ fetch: fakeFetch });
    f.forward(input(cliEvent()));
    await f.flush();
    expect(calls).toHaveLength(1);
  });

  it("swallows a thrown fetch", async () => {
    const f = forwarderWith({
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    f.forward(input(cliEvent()));
    await expect(f.flush()).resolves.toBeUndefined();
  });
});

describe("POST /v1/events with a forwarder", () => {
  function request(body: unknown): Request {
    const text = JSON.stringify(body);
    return new Request("http://localhost/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(text.length) },
      body: text,
    });
  }

  const wire = (id: string, overrides: Record<string, unknown> = {}) => ({
    command: "spawn",
    flags: { json: true },
    outcome: "success",
    durationMs: 120,
    cliVersion: "0.4.0",
    osPlatform: "linux",
    osArch: "x64",
    bunVersion: "1.3.9",
    isCI: false,
    anonymousId: id,
    ...overrides,
  });

  it("returns 204 and stores the row even when PostHog is down", async () => {
    const f = forwarderWith({
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const id = crypto.randomUUID();
    const res = await postEvent(request(wire(id)), f);
    expect(res.status).toBe(204);
    expect(firstSeenAt(id)).not.toBeNull();
    await f.flush();
  });

  it("forwards a stored event, and reports first-seen before the insert", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, now: () => Date.now() });
    const id = crypto.randomUUID();
    expect(firstSeenAt(id)).toBeNull();
    await postEvent(request(wire(id)), f);
    await f.flush();
    expect(calls[0]!.body.batch[0]!.properties.tenure_bucket).toBe("day_1");
    expect(calls[0]!.body.batch[0]!.distinct_id).toBe(id);
  });

  it("forwards nothing for a rejected event", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch });
    const res = await postEvent(request(wire(crypto.randomUUID(), { extra: "nope" })), f);
    expect(res.status).toBe(400);
    await f.flush();
    expect(calls).toHaveLength(0);
  });
});

describe("isInternalAddress", () => {
  const none = new Set<string>();

  it("treats private, loopback and link-local addresses as internal", () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "172.17.0.1",
      "172.31.255.1",
      "192.168.1.5",
      "169.254.10.10",
      "::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:172.17.0.1",
      "[::1]",
    ]) {
      expect(isInternalAddress(ip, none)).toBe(true);
    }
  });

  it("treats a public address as external unless it is listed", () => {
    expect(isInternalAddress("62.72.57.226", none)).toBe(false);
    expect(isInternalAddress("62.72.57.226", new Set(["62.72.57.226"]))).toBe(true);
    expect(isInternalAddress("  62.72.57.226  ", new Set(["62.72.57.226"]))).toBe(true);
  });

  it("does not treat the edges of the private ranges as internal", () => {
    for (const ip of [
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "192.169.0.1",
      "8.8.8.8",
      "2001:db8::1",
    ]) {
      expect(isInternalAddress(ip, none)).toBe(false);
    }
  });

  it("is false for a missing or empty address", () => {
    expect(isInternalAddress(undefined, none)).toBe(false);
    expect(isInternalAddress("", none)).toBe(false);
  });
});

describe("internal source", () => {
  it("tags a mapped event internal when the source is internal, even for an unknown id", () => {
    const ctx = { receivedAt: NOW, firstSeenAt: null, internalIds: new Set<string>() };
    const external = toPostHogEvents(cliEvent(), ctx);
    const internal = toPostHogEvents(cliEvent(), { ...ctx, internalSource: true });
    expect(external[0]!.properties.internal).toBe(false);
    expect(internal[0]!.properties.internal).toBe(true);
  });
});

describe("POST /v1/events source address", () => {
  function request(body: unknown, headers: Record<string, string> = {}): Request {
    const text = JSON.stringify(body);
    return new Request("http://localhost/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(text.length),
        ...headers,
      },
      body: text,
    });
  }

  const wire = () => ({
    command: "spawn",
    flags: {},
    outcome: "success",
    durationMs: 5,
    cliVersion: "0.4.0",
    osPlatform: "linux",
    osArch: "x64",
    bunVersion: "1.3.9",
    isCI: false,
    anonymousId: crypto.randomUUID(),
  });

  async function internalFor(
    headers: Record<string, string>,
    peer: string | undefined,
    listed: string[] = [],
  ): Promise<unknown> {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, now: () => Date.now() });
    await postEvent(request(wire(), headers), f, peer, new Set(listed));
    await f.flush();
    return calls[0]!.body.batch[0]!.properties.internal;
  }

  it("is internal for a Docker bridge address in X-Forwarded-For", async () => {
    expect(await internalFor({ "x-forwarded-for": "172.17.0.1" }, "172.18.0.1")).toBe(true);
  });

  it("is external for a public address in X-Forwarded-For, even if the peer is local", async () => {
    expect(await internalFor({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1")).toBe(false);
  });

  it("uses only the first X-Forwarded-For entry", async () => {
    expect(await internalFor({ "x-forwarded-for": "203.0.113.9, 172.17.0.1" }, undefined)).toBe(
      false,
    );
  });

  it("is internal for a listed public address", async () => {
    expect(
      await internalFor({ "x-forwarded-for": "62.72.57.226" }, undefined, ["62.72.57.226"]),
    ).toBe(true);
  });

  it("falls back to the direct peer when no header is present", async () => {
    expect(await internalFor({}, "10.0.0.7")).toBe(true);
    expect(await internalFor({}, "203.0.113.9")).toBe(false);
    expect(await internalFor({}, undefined)).toBe(false);
  });

  it("never puts an address in what is sent to PostHog", async () => {
    const { calls, fakeFetch } = recorder();
    const f = forwarderWith({ fetch: fakeFetch, now: () => Date.now() });
    await postEvent(
      request(wire(), { "x-forwarded-for": "203.0.113.9" }),
      f,
      "198.51.100.4",
      new Set(),
    );
    await f.flush();
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain("203.0.113.9");
    expect(sent).not.toContain("198.51.100.4");
    expect(sent).not.toContain("$ip");
  });
});

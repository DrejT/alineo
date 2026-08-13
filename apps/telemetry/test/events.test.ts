import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point at a throwaway db file before anything under test (config.ts/db.ts) is ever imported --
// module-level `new Database(...)` in db.ts reads this at import time.
const dir = await mkdtemp(join(tmpdir(), "alineo-telemetry-test-"));
process.env.TELEMETRY_DB_PATH = join(dir, "telemetry.db");

const { postEvent } = await import("../routes/events");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function validEventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "spawn",
    flags: { json: true },
    outcome: "success",
    durationMs: 120,
    cliVersion: "0.7.2",
    osPlatform: "linux",
    osArch: "x64",
    bunVersion: "1.3.9",
    isCI: false,
    anonymousId: crypto.randomUUID(),
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(text.length) },
    body: text,
  });
}

describe("POST /v1/events", () => {
  it("accepts a valid event and returns 204", async () => {
    const res = await postEvent(makeRequest(validEventBody()));
    expect(res.status).toBe(204);
  });

  it("accepts an error-outcome event with errorClass", async () => {
    const res = await postEvent(
      makeRequest(validEventBody({ outcome: "error", errorClass: "CommandError" })),
    );
    expect(res.status).toBe(204);
  });

  it("rejects an unexpected top-level field", async () => {
    const res = await postEvent(makeRequest(validEventBody({ extra: "nope" })));
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean flag value", async () => {
    const res = await postEvent(makeRequest(validEventBody({ flags: { json: "yes" } })));
    expect(res.status).toBe(400);
  });

  it("rejects too many flag entries", async () => {
    const flags: Record<string, boolean> = {};
    for (let i = 0; i < 25; i++) flags[`f${i}`] = true;
    const res = await postEvent(makeRequest(validEventBody({ flags })));
    expect(res.status).toBe(400);
  });

  it("rejects a missing required field", async () => {
    const body = validEventBody();
    delete body.command;
    const res = await postEvent(makeRequest(body));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid outcome value", async () => {
    const res = await postEvent(makeRequest(validEventBody({ outcome: "maybe" })));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await postEvent(
      new Request("http://localhost/v1/events", {
        method: "POST",
        headers: { "content-length": "9" },
        body: "not json!",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a too-large body via Content-Length", async () => {
    const res = await postEvent(makeRequest(validEventBody({ command: "x".repeat(10000) })));
    expect(res.status).toBe(413);
  });

  it("rate limits after too many requests from the same anonymousId", async () => {
    const anonymousId = crypto.randomUUID();
    let lastStatus = 0;
    for (let i = 0; i < 35; i++) {
      lastStatus = (await postEvent(makeRequest(validEventBody({ anonymousId })))).status;
    }
    expect(lastStatus).toBe(429);
  });

  it("does not rate limit a different anonymousId after another one gets limited", async () => {
    const limited = crypto.randomUUID();
    for (let i = 0; i < 35; i++) {
      await postEvent(makeRequest(validEventBody({ anonymousId: limited })));
    }
    const res = await postEvent(makeRequest(validEventBody({ anonymousId: crypto.randomUUID() })));
    expect(res.status).toBe(204);
  });
});

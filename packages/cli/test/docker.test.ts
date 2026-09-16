import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { pollHealth, isReachable } from "../src/docker.js";
import { stubFetch } from "./fetch-stub.ts";

describe("pollHealth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves when server returns { status: 'healthy' }", async () => {
    globalThis.fetch = stubFetch(async () => {
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    });

    await expect(pollHealth("http://localhost:8080/health", 5_000)).resolves.toBeUndefined();
  });

  it("throws after timeout if server never becomes healthy", async () => {
    globalThis.fetch = stubFetch(async () => {
      return new Response(JSON.stringify({ status: "starting" }), { status: 200 });
    });

    await expect(pollHealth("http://localhost:8080/health", 100)).rejects.toThrow(
      /did not become healthy/,
    );
  });

  it("throws after timeout if server is unreachable", async () => {
    globalThis.fetch = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(pollHealth("http://localhost:8080/health", 100)).rejects.toThrow(
      /did not become healthy/,
    );
  });
});

describe("isReachable", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true when the health check succeeds", async () => {
    globalThis.fetch = stubFetch(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(
      isReachable("http://localhost:4600/health", (b) => (b as { ok?: boolean }).ok === true, 100),
    ).resolves.toBe(true);
  });

  it("returns false instead of throwing when the health check never succeeds — this is what lets ensureAlineod distinguish 'running per Docker' from 'actually reachable'", async () => {
    globalThis.fetch = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(isReachable("http://localhost:4600/health", undefined, 100)).resolves.toBe(false);
  });
});

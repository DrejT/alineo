import { describe, expect, it, vi, afterEach } from "vitest";
import { ControlClient, OpenSandboxError } from "../src/control.ts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("ControlClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listSandboxes() unwraps the {items} envelope into a bare array", async () => {
    const sandboxes = [
      { id: "a", status: { state: "Running" }, createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", status: { state: "Terminated" }, createdAt: "2026-01-02T00:00:00Z" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: sandboxes }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ControlClient({ baseUrl: "http://localhost:8080", apiKey: "" });
    const result = await client.listSandboxes();

    expect(result).toEqual(sandboxes);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/v1/sandboxes",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("listSnapshots() unwraps the {items} envelope and flattens each snapshot", async () => {
    const rawSnapshots = [
      {
        id: "snap-1",
        sandboxId: "sb-1",
        status: { state: "Ready" },
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: rawSnapshots }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ControlClient({ baseUrl: "http://localhost:8080", apiKey: "" });
    const result = await client.listSnapshots();

    expect(result).toEqual([
      { id: "snap-1", sandboxId: "sb-1", state: "Ready", createdAt: "2026-01-01T00:00:00Z" },
    ]);
  });
});

describe("ControlClient errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A non-2xx response whose body is exactly `body`. */
  function failing(status: number, body: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => body }),
    );
    return new ControlClient({ baseUrl: "http://localhost:8080", apiKey: "" }).getSandbox("sb-1");
  }

  it("unwraps OpenSandbox's JSON error body into a readable message and a code", async () => {
    const err = await failing(
      404,
      JSON.stringify({ code: "DOCKER::SANDBOX_NOT_FOUND", message: "Sandbox sb-1 not found." }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenSandboxError);
    expect(err).toMatchObject({
      message: "Sandbox sb-1 not found. (DOCKER::SANDBOX_NOT_FOUND)",
      code: "DOCKER::SANDBOX_NOT_FOUND",
      status: 404,
    });
  });

  it("a JSON body with a message but no code is just the message", async () => {
    const err = await failing(429, JSON.stringify({ message: "slow down" })).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: "slow down", code: undefined, status: 429 });
  });

  it.each([
    ["plain text", "gateway timeout", "gateway timeout"],
    ["JSON without a message", '{"code":"X"}', '{"code":"X"}'],
    ["JSON that isn't an object", "[1,2]", "[1,2]"],
    ["an empty body", "", "OpenSandbox API error"],
  ])("keeps the raw text when the body is %s", async (_name, body, message) => {
    const err = await failing(500, body).catch((e: unknown) => e);
    expect(err).toMatchObject({ message, status: 500 });
    expect((err as OpenSandboxError).code).toBeUndefined();
  });
});

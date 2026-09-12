import { describe, expect, it, vi, afterEach } from "vitest";
import { ControlClient } from "../src/control.ts";

function jsonResponse<T>(body: T, ok = true, status = 200) {
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressClient, EgressClientError } from "../src/egress.ts";
import type { ControlClient } from "../src/control.ts";

function fakeControl(
  endpoint = "http://10.1.2.3:18080",
  headers: Record<string, string> = { "X-EXECD-ACCESS-TOKEN": "t" },
): ControlClient {
  return {
    getEndpoint: vi.fn().mockResolvedValue({ endpoint, headers }),
  } as unknown as ControlClient;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** The `[url, init]` pair of the first fetch call, typed. */
function firstCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit];
}

describe("EgressClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("patchRules PATCHes a bare rule array to :18080/policy with the endpoint headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", mode: "enforcing" }));
    vi.stubGlobal("fetch", fetchMock);

    const rules = [{ action: "allow" as const, target: "api.github.com" }];
    const res = await new EgressClient(fakeControl()).patchRules("sb-1", rules);

    expect(res).toEqual({ status: "ok", mode: "enforcing" });
    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://10.1.2.3:18080/policy");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify(rules));
    expect(init.headers).toMatchObject({
      "X-EXECD-ACCESS-TOKEN": "t",
      "Content-Type": "application/json",
    });
  });

  it("deleteRules DELETEs a bare target-string array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await new EgressClient(fakeControl()).deleteRules("sb-1", ["api.github.com"]);

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe("http://10.1.2.3:18080/policy");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify(["api.github.com"]));
  });

  it("getPolicy GETs with no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", policy: null }));
    vi.stubGlobal("fetch", fetchMock);

    await new EgressClient(fakeControl()).getPolicy("sb-1");

    const [, init] = firstCall(fetchMock);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("throws EgressClientError with the status on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("bad rule", false, 400)));

    const err = await new EgressClient(fakeControl())
      .patchRules("sb-1", [{ action: "allow", target: "x" }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressClientError);
    expect((err as EgressClientError).status).toBe(400);
  });

  it("prefixes a bare host:port endpoint with http://", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await new EgressClient(fakeControl("10.9.9.9:18080", {})).getPolicy("sb-1");

    expect(firstCall(fetchMock)[0]).toBe("http://10.9.9.9:18080/policy");
  });
});

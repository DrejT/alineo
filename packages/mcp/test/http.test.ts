import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpMcp, type HttpMcpOptions } from "../src/http.js";
import { MemorySpecStore, type SpecStore } from "../src/spec-store.js";
import { stubFetch } from "./fetch-stub.js";

const URL_ = "http://mcp.test/mcp";

/** An MCP client whose network is the handler itself. */
async function connect(options: HttpMcpOptions, headers: Record<string, string> = {}) {
  const mcp = createHttpMcp(options);
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (url: string | URL, init?: RequestInit) => mcp.fetch(new Request(url, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    mcp,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

const textOf = (result: { content?: unknown }) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

describe("createHttpMcp", () => {
  it("refuses a request with no Authorization header, with a 401", async () => {
    const mcp = createHttpMcp({});
    const res = await mcp.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHENTICATED");
    await mcp.close();
  });

  it("lists the remote tool set. With no store: no init and no spec recall", async () => {
    const { client, close } = await connect({}, { authorization: "Bearer user-1" });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("run_start");
      expect(names).toContain("run_list");
      expect(names).toContain("spec_add");
      expect(names).not.toContain("spec_get");
      expect(names).not.toContain("init");
    } finally {
      await close();
    }
  });

  it("forwards the caller's own Authorization header to alineod, and sends no other", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    const one = await connect(
      { baseUrl: "http://alineod.test", fetchImpl },
      { authorization: "Bearer user-1" },
    );
    await one.client.callTool({ name: "run_list", arguments: {} });
    await one.close();
    const two = await connect(
      { baseUrl: "http://alineod.test", fetchImpl },
      { authorization: "Bearer user-2" },
    );
    await two.client.callTool({ name: "run_list", arguments: {} });
    await two.close();
    expect(seen).toEqual(["Bearer user-1", "Bearer user-2"]);
  });

  it("does not fall back to ALINEOD_API_KEY, which would be the server's own credential", async () => {
    const saved = process.env.ALINEOD_API_KEY;
    process.env.ALINEOD_API_KEY = "the-server-key";
    try {
      const seen: Array<string | null> = [];
      const fetchImpl = stubFetch(async (_url, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      });
      const c = await connect(
        { baseUrl: "http://alineod.test", fetchImpl },
        { authorization: "Bearer user-1" },
      );
      await c.client.callTool({ name: "run_list", arguments: {} });
      await c.close();
      expect(seen).toEqual(["Bearer user-1"]);
    } finally {
      if (saved === undefined) delete process.env.ALINEOD_API_KEY;
      else process.env.ALINEOD_API_KEY = saved;
    }
  });

  it("passes alineod's 401 back as a tool error", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(
          JSON.stringify({ error: "authentication required", code: "UNAUTHENTICATED" }),
          { status: 401 },
        ),
    );
    const c = await connect(
      { baseUrl: "http://alineod.test", fetchImpl },
      { authorization: "Bearer bad" },
    );
    try {
      const result = await c.client.callTool({ name: "run_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("401");
    } finally {
      await c.close();
    }
  });

  it("asks specsFor for a store per caller, so users do not share specs", async () => {
    const stores = new Map<string, SpecStore>();
    const specsFor = (authorization: string | undefined): SpecStore => {
      const key = authorization ?? "";
      if (!stores.has(key)) stores.set(key, new MemorySpecStore());
      return stores.get(key)!;
    };
    const spec = { name: "private", harness: "pi", model: "some-model" };
    const a = await connect({ specsFor }, { authorization: "Bearer a" });
    await a.client.callTool({ name: "spec_add", arguments: { spec } });
    const aList = await a.client.callTool({ name: "spec_list", arguments: {} });
    await a.close();
    const b = await connect({ specsFor }, { authorization: "Bearer b" });
    const bList = await b.client.callTool({ name: "spec_list", arguments: {} });
    await b.close();
    expect(JSON.parse(textOf(aList))).toHaveLength(1);
    expect(JSON.parse(textOf(bList))).toEqual([]);
  });

  it("serves with no Authorization header when told to, and sends none to alineod", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    const saved = process.env.ALINEOD_API_KEY;
    delete process.env.ALINEOD_API_KEY;
    try {
      const c = await connect({
        requireAuthorization: false,
        baseUrl: "http://alineod.test",
        fetchImpl,
      });
      await c.client.callTool({ name: "run_list", arguments: {} });
      await c.close();
      expect(seen).toEqual([null]);
    } finally {
      if (saved !== undefined) process.env.ALINEOD_API_KEY = saved;
    }
  });
});

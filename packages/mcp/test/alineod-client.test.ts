import { describe, expect, it } from "bun:test";
import { AlineodClient, AlineodError } from "../src/alineod-client.js";
import { stubFetch } from "./fetch-stub.js";
import { expectRejects } from "./assertions.js";

describe("AlineodClient requests", () => {
  it("POSTs a JSON body and parses the JSON response", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(
        JSON.stringify({ runId: "r1", rootAgentId: "a1", state: "provisioning" }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });

    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });
    const result = await client.createRun({
      spec: { name: "x", harness: "pi", model: "some-model" },
    });

    expect(seenUrl).toBe("http://test.local:4600/runs");
    expect(seenInit?.method).toBe("POST");
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      spec: { name: "x", harness: "pi", model: "some-model" },
    });
    expect(result).toEqual({ runId: "r1", rootAgentId: "a1", state: "provisioning" });
  });

  it("treats a 204 response as void, not a JSON-parse attempt", async () => {
    const fetchImpl = stubFetch(async () => new Response(null, { status: 204 }));
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    expect(await client.deleteRun("r1")).toBeUndefined();
  });

  it("surfaces a non-2xx response's error field as an AlineodError", async () => {
    const fetchImpl = stubFetch(
      async () => new Response(JSON.stringify({ error: "no run r1" }), { status: 404 }),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const err = await expectRejects(client.getRun("r1"));
    expect(err).toBeInstanceOf(AlineodError);
    expect((err as Error).message).toBe("no run r1");
  });

  it("keeps a known error code from the response body", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "agent is not live", code: "SANDBOX_NOT_RUNNING" }), {
          status: 409,
        }),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const err = (await expectRejects(client.getRun("r1"))) as AlineodError;
    expect(err.code).toBe("SANDBOX_NOT_RUNNING");
    expect(err.status).toBe(409);
  });

  it("drops a code this build does not know, instead of passing it off as an ErrorCode", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "x", code: "SOME_FUTURE_CODE" }), { status: 500 }),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const err = (await expectRejects(client.getRun("r1"))) as AlineodError;
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("x");
  });

  it("an error body with no code has no code", async () => {
    const fetchImpl = stubFetch(
      async () => new Response(JSON.stringify({ error: "no run r1" }), { status: 404 }),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const err = (await expectRejects(client.getRun("r1"))) as AlineodError;
    expect(err.code).toBeUndefined();
  });

  it("wraps a network failure in a helpful AlineodError", async () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const err = await expectRejects(client.getAgent("a1"));
    expect((err as Error).message).toContain("Could not reach alineod");
  });

  it("appends ?wait= only when waitSeconds is passed", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = stubFetch(async (url) => {
      seenUrls.push(String(url));
      return new Response(
        JSON.stringify({
          agentId: "a1",
          state: "pending",
          outcome: null,
          resultRef: null,
          result: null,
        }),
        { status: 200 },
      );
    });
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    await client.getResult("a1");
    await client.getResult("a1", 30);

    expect(seenUrls[0]).toBe("http://test.local:4600/agents/a1/result");
    expect(seenUrls[1]).toBe("http://test.local:4600/agents/a1/result?wait=30");
  });

  it("omits the body for stopAgent when no mode is given, includes it when given", async () => {
    const bodies: (string | undefined)[] = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      bodies.push(init?.body as string | undefined);
      return new Response(null, { status: 202 });
    });
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    await client.stopAgent("a1");
    await client.stopAgent("a1", "drain");

    expect(bodies[0]).toBeUndefined();
    expect(bodies[1]).toBe(JSON.stringify({ mode: "drain" }));
  });
});

describe("AlineodClient.watchEvents", () => {
  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const frame of frames) controller.enqueue(enc.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("parses id/event/data frames into structured events", async () => {
    const fetchImpl = stubFetch(async () =>
      sseResponse([
        'id: 1\nevent: run.started\ndata: {"runId":"r1"}\n\n',
        'id: 2\nevent: agent.ended\ndata: {"agentId":"a1","outcome":"done"}\n\n',
      ]),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const events = await client.watchEvents("r1", { maxWaitMs: 1000 });

    expect(events).toEqual([
      { id: 1, event: "run.started", data: { runId: "r1" } },
      { id: 2, event: "agent.ended", data: { agentId: "a1", outcome: "done" } },
    ]);
  });

  it("stops collecting once maxEvents is reached", async () => {
    const fetchImpl = stubFetch(async () =>
      sseResponse([
        "id: 1\nevent: a\ndata: {}\n\n",
        "id: 2\nevent: b\ndata: {}\n\n",
        "id: 3\nevent: c\ndata: {}\n\n",
      ]),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const events = await client.watchEvents("r1", { maxWaitMs: 1000, maxEvents: 2 });

    expect(events.length).toBe(2);
  });

  it("ignores heartbeat comment lines", async () => {
    const fetchImpl = stubFetch(async () =>
      sseResponse([": ping\n\n", 'id: 1\nevent: run.started\ndata: {"runId":"r1"}\n\n']),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const events = await client.watchEvents("r1", { maxWaitMs: 1000 });

    expect(events).toEqual([{ id: 1, event: "run.started", data: { runId: "r1" } }]);
  });
});

describe("AlineodClient credentials", () => {
  const headersOf = (init?: RequestInit) => new Headers(init?.headers);

  it("sends no Authorization header when no key is set", async () => {
    const saved = process.env.ALINEOD_API_KEY;
    delete process.env.ALINEOD_API_KEY;
    try {
      let seen: RequestInit | undefined;
      const fetchImpl = stubFetch(async (_url, init) => {
        seen = init;
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      });
      await new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl }).listRuns();
      expect(headersOf(seen).has("authorization")).toBe(false);
    } finally {
      if (saved !== undefined) process.env.ALINEOD_API_KEY = saved;
    }
  });

  it("sends apiKey as a bearer token, with and without a body", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    const client = new AlineodClient({
      baseUrl: "http://test.local:4600",
      fetchImpl,
      apiKey: "k1",
    });
    await client.listRuns();
    await client.createRun({ spec: { name: "x" } });
    expect(headersOf(seen[0]).get("authorization")).toBe("Bearer k1");
    expect(headersOf(seen[1]).get("authorization")).toBe("Bearer k1");
    expect(headersOf(seen[1]).get("content-type")).toBe("application/json");
  });

  it("reads ALINEOD_API_KEY when no apiKey is passed", async () => {
    const saved = process.env.ALINEOD_API_KEY;
    process.env.ALINEOD_API_KEY = "from-env";
    try {
      let seen: RequestInit | undefined;
      const fetchImpl = stubFetch(async (_url, init) => {
        seen = init;
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      });
      await new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl }).listRuns();
      expect(headersOf(seen).get("authorization")).toBe("Bearer from-env");
    } finally {
      if (saved === undefined) delete process.env.ALINEOD_API_KEY;
      else process.env.ALINEOD_API_KEY = saved;
    }
  });

  it("takes the header per call from `authorization`, ahead of apiKey", async () => {
    let caller = "Bearer user-1";
    const seen: string[] = [];
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.push(headersOf(init).get("authorization") ?? "");
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    const client = new AlineodClient({
      baseUrl: "http://test.local:4600",
      fetchImpl,
      apiKey: "ignored",
      authorization: () => caller,
    });
    await client.listRuns();
    caller = "Bearer user-2";
    await client.listRuns();
    expect(seen).toEqual(["Bearer user-1", "Bearer user-2"]);
  });

  it("sends the credential on the event stream too", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = stubFetch(async (_url, init) => {
      seen = init;
      return new Response("", { status: 200 });
    });
    await new AlineodClient({
      baseUrl: "http://test.local:4600",
      fetchImpl,
      apiKey: "k1",
    }).watchEvents("r1", { maxWaitMs: 50 });
    expect(headersOf(seen).get("authorization")).toBe("Bearer k1");
    expect(headersOf(seen).get("last-event-id")).toBe("0");
  });
});

describe("AlineodClient.listRuns", () => {
  it("asks for /runs with no query by default", async () => {
    let seenUrl = "";
    const fetchImpl = stubFetch(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    await new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl }).listRuns();
    expect(seenUrl).toBe("http://test.local:4600/runs");
  });

  it("passes limit and state", async () => {
    let seenUrl = "";
    const fetchImpl = stubFetch(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    });
    await new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl }).listRuns({
      limit: 5,
      state: "open",
    });
    expect(seenUrl).toBe("http://test.local:4600/runs?limit=5&state=open");
  });
});

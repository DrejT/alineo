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
        'id: 1\nevent: run_started\ndata: {"runId":"r1"}\n\n',
        'id: 2\nevent: agent_ended\ndata: {"agentId":"a1","outcome":"done"}\n\n',
      ]),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const events = await client.watchEvents("r1", { maxWaitMs: 1000 });

    expect(events).toEqual([
      { id: 1, event: "run_started", data: { runId: "r1" } },
      { id: 2, event: "agent_ended", data: { agentId: "a1", outcome: "done" } },
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
      sseResponse([": ping\n\n", 'id: 1\nevent: run_started\ndata: {"runId":"r1"}\n\n']),
    );
    const client = new AlineodClient({ baseUrl: "http://test.local:4600", fetchImpl });

    const events = await client.watchEvents("r1", { maxWaitMs: 1000 });

    expect(events).toEqual([{ id: 1, event: "run_started", data: { runId: "r1" } }]);
  });
});

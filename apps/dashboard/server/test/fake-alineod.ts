/**
 * A tiny stand-in for alineod's HTTP API, served on a real local port. The dashboard server only
 * ever talks to alineod over HTTP, so a fake server tests the real pass-through and the real
 * swarm realization with no mocking of the client code.
 */
export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export const fakeAlineod = {
  url: "",
  calls: [] as RecordedCall[],
  /** Agent ids that answer `POST /runs/:id/agents` with 409 "not live" until `makeLive` runs. */
  notLive: new Set<string>(),
  /** State `GET /agents/:id` reports, per agent. Default "running". */
  agentState: new Map<string, string>(),
  /** Make the whole server answer 503, to test the unreachable/upstream-error path. */
  down: false,
  nextAgent: 0,
  reset(): void {
    this.calls = [];
    this.notLive.clear();
    this.agentState.clear();
    this.down = false;
    this.nextAgent = 0;
  },
};

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

export function startFakeAlineod(): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      const body = text ? JSON.parse(text) : undefined;
      fakeAlineod.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });

      if (url.pathname === "/health") return json({ ok: true });
      if (fakeAlineod.down) return json({ error: "alineod is down" }, 503);

      if (req.method === "POST" && url.pathname === "/runs") {
        return json({ runId: "run_1", rootAgentId: "a_root", state: "provisioning" }, 202);
      }
      if (req.method === "GET" && url.pathname === "/runs") {
        return json({ runs: [{ runId: "run_1", rootAgentId: "a_root", asOf: 1 }] });
      }
      if (req.method === "POST" && /^\/runs\/[^/]+\/agents$/.test(url.pathname)) {
        if (fakeAlineod.notLive.has(body.parentAgentId)) {
          return json({ error: `agent ${body.parentAgentId} is not live` }, 409);
        }
        return json({ agentId: `a_${++fakeAlineod.nextAgent}`, state: "provisioning" }, 202);
      }
      const agent = url.pathname.match(/^\/agents\/([^/]+)$/);
      if (req.method === "GET" && agent) {
        return json({ agentId: agent[1], state: fakeAlineod.agentState.get(agent[1]!) ?? "running" });
      }
      if (req.method === "PATCH" && url.pathname.includes("/permissions/")) {
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" && /^\/runs\/[^/]+\/events$/.test(url.pathname)) {
        const from = Number(req.headers.get("last-event-id") ?? "0");
        const frames = [1, 2, 3]
          .filter((id) => id > from)
          .map((id) => `id: ${id}\nevent: agent.spawned\ndata: {"n":${id}}\n\n`);
        return new Response(frames.join(""), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return json({ error: "not found" }, 404);
    },
  });
  fakeAlineod.url = `http://127.0.0.1:${server.port}`;
  return fakeAlineod.url;
}

/** Runs and agents are alineod's. The dashboard server forwards them unchanged. */
import { afterEach, describe, expect, test } from "bun:test";
import { app, call, TOKEN } from "./helpers";
import { fakeAlineod } from "./fake-alineod";

afterEach(() => fakeAlineod.reset());

describe("passthrough to alineod", () => {
  test("GET /runs is forwarded and the answer returned", async () => {
    const res = await call("GET", "/runs");
    expect(res.status).toBe(200);
    expect(res.body.runs[0].runId).toBe("run_1");
  });

  test("POST bodies reach alineod intact", async () => {
    const res = await call("POST", "/runs", { spec: { name: "x" }, prompt: "hi" });
    expect(res.status).toBe(202);
    const sent = fakeAlineod.calls.find((c) => c.method === "POST" && c.path === "/runs");
    expect(sent?.body).toEqual({ spec: { name: "x" }, prompt: "hi" });
  });

  test("the browser's Authorization header is never forwarded", async () => {
    await call("GET", "/runs");
    const sent = fakeAlineod.calls.find((c) => c.path === "/runs");
    expect(sent?.headers.get("authorization")).toBeNull();
  });

  test("PATCH …/permissions/:id is forwarded", async () => {
    const res = await call("PATCH", "/agents/a_1/permissions/r1", { decision: { kind: "once" } });
    expect(res.status).toBe(204);
    expect(fakeAlineod.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/agents/a_1/permissions/r1" });
  });

  test("an upstream error keeps its status", async () => {
    fakeAlineod.down = true;
    expect((await call("GET", "/runs")).status).toBe(503);
  });

  test("the passthrough still needs the token", async () => {
    expect((await call("GET", "/runs", undefined, {})).status).toBe(401);
  });

  test("SSE streams through and Last-Event-ID reaches alineod", async () => {
    const res = await app.handle(
      new Request("http://dashboard.test/runs/run_1/events", {
        headers: { authorization: `Bearer ${TOKEN}`, "last-event-id": "2" },
      }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 1");
    expect(fakeAlineod.calls.find((c) => c.path.endsWith("/events"))?.headers.get("last-event-id")).toBe("2");
  });
});

describe("GET /settings", () => {
  test("reports alineod reachability and auth", async () => {
    const res = await call("GET", "/settings");
    expect(res.body.alineod.reachable).toBe(true);
    expect(res.body.authEnabled).toBe(true);
    expect(res.body.modelProviders.map((p: { id: string }) => p.id)).toContain("google");
  });
});

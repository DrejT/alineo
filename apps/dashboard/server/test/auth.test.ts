/** Bearer token, WebSocket tickets, CORS, and the refuse-to-start rule. */
import { describe, expect, test } from "bun:test";
import { app, call, TOKEN } from "./helpers";
import { assertAuthConfig, issueTicket, tokenMatches } from "../auth";

describe("bearer token", () => {
  test("401 without a token", async () => {
    expect((await call("GET", "/settings", undefined, {})).status).toBe(401);
  });

  test("401 with a wrong token", async () => {
    expect((await call("GET", "/settings", undefined, { authorization: "Bearer nope" })).status).toBe(401);
  });

  test("200 with the right token", async () => {
    expect((await call("GET", "/settings")).status).toBe(200);
  });

  test("/health needs no token", async () => {
    expect((await call("GET", "/health", undefined, {})).status).toBe(200);
  });

  test("tokenMatches rejects a token that differs only in length", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
  });
});

describe("WebSocket tickets", () => {
  const upgrade = (query: string) =>
    app.handle(
      new Request(`http://dashboard.test/sandboxes/sb-1/exec${query}`, { headers: { upgrade: "websocket" } }),
    );

  test("an upgrade without a ticket is 401", async () => {
    expect((await upgrade("")).status).toBe(401);
  });

  test("POST /auth/ticket needs the bearer token", async () => {
    expect((await call("POST", "/auth/ticket", undefined, {})).status).toBe(401);
    const res = await call("POST", "/auth/ticket");
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeString();
  });

  test("a ticket works once", async () => {
    const ticket = issueTicket();
    expect((await upgrade(`?ticket=${ticket}`)).status).not.toBe(401);
    expect((await upgrade(`?ticket=${ticket}`)).status).toBe(401);
  });

  test("a bearer header does not open a socket", async () => {
    const res = await app.handle(
      new Request("http://dashboard.test/sandboxes/sb-1/exec", {
        headers: { upgrade: "websocket", authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("CORS", () => {
  test("reflects an allowed origin and answers preflight without a token", async () => {
    const res = await app.handle(
      new Request("http://dashboard.test/settings", { method: "OPTIONS", headers: { origin: "http://localhost:4321" } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });

  test("sends no CORS headers to an unknown origin", async () => {
    const res = await app.handle(
      new Request("http://dashboard.test/health", { headers: { origin: "https://evil.example" } }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("assertAuthConfig", () => {
  test("passes with a token", () => {
    expect(() => assertAuthConfig({ token: "t", allowNoAuth: false, host: "0.0.0.0" })).not.toThrow();
  });

  test("refuses to start with no token", () => {
    expect(() => assertAuthConfig({ token: "", allowNoAuth: false, host: "127.0.0.1" })).toThrow(/DASHBOARD_TOKEN/);
  });

  test("allows no token only as an explicit loopback opt-in", () => {
    expect(() => assertAuthConfig({ token: "", allowNoAuth: true, host: "127.0.0.1" })).not.toThrow();
    expect(() => assertAuthConfig({ token: "", allowNoAuth: true, host: "0.0.0.0" })).toThrow(/loopback/);
  });
});

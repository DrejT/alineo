/**
 * The status code a client gets when a request can't be served. `http-api.mdx` promises
 * `{ "error": "<message>" }` "with an appropriate status; an invalid body is 400" — Elysia's own
 * errors (unknown route, unparseable body) used to fall through to a blanket 500.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HttpError } from "../src/engine/errors";
import { parseBody, toErrorResponse } from "../src/routes/http";
import { app, call } from "./helpers";

async function raw(method: string, path: string, body?: string) {
  const res = await app.handle(
    new Request(`http://alineod.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: unknown } };
}

describe("errors Elysia raises itself", () => {
  test("an unknown route is a 404, not a 500", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  test("an unknown nested route is a 404", async () => {
    expect((await call("GET", "/runs/r_1/nope/deeper")).status).toBe(404);
  });

  test("a method the route doesn't have is a 404", async () => {
    expect((await call("DELETE", "/health")).status).toBe(404);
  });

  test("an unparseable JSON body is a 400, not a 500", async () => {
    const res = await raw("POST", "/runs", "{ this is not json");
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });
});

describe("errors alineod raises itself are unchanged", () => {
  test("a body of the wrong shape is a 400 naming the field", async () => {
    const res = await call("POST", "/runs", { spec: 123 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("spec");
  });

  test("a missing agent is a 404 with its own message", async () => {
    const res = await call("GET", "/agents/a_nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no agent a_nope" });
  });
});

describe("toErrorResponse", () => {
  test.each([
    ["NOT_FOUND", 404],
    ["PARSE", 400],
    ["VALIDATION", 400],
    ["INVALID_COOKIE_SIGNATURE", 400],
  ])("Elysia %s answers %d", async (code, status) => {
    expect(toErrorResponse(new Error("x"), { code }).status).toBe(status);
  });

  test("anything else is still a 500 with the message", async () => {
    const res = toErrorResponse(new Error("boom"), { code: "UNKNOWN" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  test("no code (the old call shape) is a 500", () => {
    expect(toErrorResponse(new Error("x")).status).toBe(500);
  });
});

describe("parseBody messages", () => {
  const schema = z.object({ spec: z.object({ name: z.string() }) });
  const message = (value: unknown): string => {
    try {
      parseBody(schema, value);
    } catch (err) {
      if (err instanceof HttpError) return err.message;
      throw err;
    }
    throw new Error("expected parseBody to throw");
  };

  test("a nested failure names the field", () => {
    expect(message({ spec: { name: 1 } })).toStartWith("invalid request body: spec.name: ");
  });

  test("a body that is the wrong type overall has no dangling ': '", () => {
    const m = message("nope");
    expect(m).toStartWith("invalid request body: ");
    expect(m).not.toContain(": :");
    expect(m).not.toMatch(/: $/);
  });

  test("several issues are joined with '; ' and each is named when it has a path", () => {
    expect(message({ spec: {} })).toStartWith("invalid request body: spec.name: ");
    const two = z.object({ a: z.string(), b: z.string() });
    expect(() => parseBody(two, {})).toThrow(/a: .*; b: /);
  });
});

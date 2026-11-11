/**
 * Authentication hook. The hook is optional and off by default: `createApp()` with no options
 * behaves exactly as before (every other test file relies on that). With a hook set, every route
 * except `GET /health` needs a principal.
 *
 * The scope test matters most: Elysia hooks are local by default, so a hook on the parent can miss
 * routes that arrive through `.use(plugin)`. Each route family is probed here, not just one.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { principalOf, tokenAuthenticate, type Authenticate } from "../src/auth";

const byHeader: Authenticate = (req) => {
  const h = req.headers.get("authorization");
  if (h === "Bearer key-a") return { tenantId: "a" };
  if (h === "Bearer key-b") return { tenantId: "b" };
  return null;
};

interface Handles {
  handle: (request: Request) => Response | Promise<Response>;
}

async function hit(app: Handles, method: string, path: string, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "DELETE") init.body = "{}";
  const res = await app.handle(new Request(`http://alineod.test${path}`, init));
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as { code?: string } | null;
  return { status: res.status, body };
}

// One route per family, including the ones mounted with `.use()`.
const PROBES: Array<[string, string]> = [
  ["POST", "/runs"],
  ["GET", "/runs/r_missing"],
  ["DELETE", "/runs/r_missing"],
  ["GET", "/runs/r_missing/events"],
  ["POST", "/runs/r_missing/agents"],
  ["GET", "/agents/a_missing"],
  ["GET", "/agents/a_missing/transcript"],
  ["POST", "/agents/a_missing/prompt"],
  ["POST", "/agents/a_missing/steer"],
  ["POST", "/agents/a_missing/pause"],
  ["POST", "/agents/a_missing/resume"],
  ["POST", "/agents/a_missing/stop"],
  ["POST", "/agents/a_missing/notify-on"],
  ["GET", "/agents/a_missing/inbox"],
  ["POST", "/agents/a_missing/inbox/deliver"],
  ["GET", "/agents/a_missing/result"],
  ["GET", "/agents/a_missing/await"],
  ["POST", "/runs/r_missing/await"],
  ["GET", "/agents/a_missing/memory"],
  ["GET", "/agents/a_missing/facts"],
  ["GET", "/openapi"],
  ["GET", "/no-such-route"],
];

describe("no hook (the default)", () => {
  test("createApp() with no options asks for no credentials", async () => {
    const app = createApp();
    const res = await hit(app, "GET", "/agents/a_missing");
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("with an authenticate hook", () => {
  const app = createApp({ authenticate: byHeader });

  test("GET /health stays open", async () => {
    expect((await hit(app, "GET", "/health")).status).toBe(200);
  });

  for (const [method, path] of PROBES) {
    test(`${method} ${path} without a credential is 401`, async () => {
      const res = await hit(app, method, path);
      expect(res.status).toBe(401);
      expect(res.body?.code).toBe("UNAUTHENTICATED");
    });

    test(`${method} ${path} with a wrong credential is 401`, async () => {
      expect((await hit(app, method, path, "nope")).status).toBe(401);
    });
  }

  test("a valid credential reaches the route", async () => {
    const res = await hit(app, "GET", "/agents/a_missing", "key-a");
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("AGENT_NOT_FOUND");
  });

  test("the 401 body does not echo the credential", async () => {
    const res = await hit(app, "GET", "/agents/a_missing", "super-secret-value");
    expect(JSON.stringify(res.body)).not.toContain("super-secret-value");
  });

  test("an async hook is awaited", async () => {
    const asyncApp = createApp({
      authenticate: async (req) => {
        await Bun.sleep(5);
        return byHeader(req);
      },
    });
    expect((await hit(asyncApp, "GET", "/agents/a_missing")).status).toBe(401);
    expect((await hit(asyncApp, "GET", "/agents/a_missing", "key-b")).status).toBe(404);
  });

  test("a hook that throws is a 401, not a 500", async () => {
    const throwing = createApp({
      authenticate: () => {
        throw new Error("key store down");
      },
    });
    const res = await hit(throwing, "GET", "/agents/a_missing", "key-a");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("key store down");
  });

  test("the handler can read the principal the hook returned", async () => {
    let seen: string | undefined;
    const spy = createApp({
      authenticate: (req) => {
        const p = byHeader(req);
        return p;
      },
    }).get("/whoami", ({ request }) => {
      seen = principalOf(request)?.tenantId;
      return { ok: true };
    });
    await hit(spy, "GET", "/whoami", "key-b");
    expect(seen).toBe("b");
  });
});

describe("tokenAuthenticate (single shared secret)", () => {
  const app = createApp({ authenticate: tokenAuthenticate("s3cret") });

  test("the right token passes, as the default tenant", async () => {
    expect((await hit(app, "GET", "/agents/a_missing", "s3cret")).status).toBe(404);
    const principal = tokenAuthenticate("s3cret")(
      new Request("http://x/", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(principal).toEqual({ tenantId: "default" });
  });

  test("a wrong token, a longer token and a missing token are all 401", async () => {
    expect((await hit(app, "GET", "/agents/a_missing", "s3cre")).status).toBe(401);
    expect((await hit(app, "GET", "/agents/a_missing", "s3cret-and-more")).status).toBe(401);
    expect((await hit(app, "GET", "/agents/a_missing")).status).toBe(401);
  });

  test("a non-Bearer scheme is 401", async () => {
    const res = await app.handle(
      new Request("http://alineod.test/agents/a_missing", {
        headers: { authorization: "Basic s3cret" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("an empty configured token refuses to build", () => {
    expect(() => tokenAuthenticate("")).toThrow();
  });
});

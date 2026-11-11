/**
 * Tenant isolation. With an `authenticate` hook, a run belongs to the tenant that created it and no
 * other tenant may see it, change it or learn that it exists.
 *
 * The matrix lists every route that names a run or an agent. A second test reads the app's own route
 * table and fails when a route is in neither the matrix nor the short exempt list, so a new route
 * cannot ship unguarded by accident.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEFAULT_TENANT, tokenAuthenticate, type Authenticate } from "../src/auth";
import { getAgentRow, getRun, rebuild } from "../src/state/projection";
import { call as callNoAuth, spec, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

const byHeader: Authenticate = (req) => {
  const h = req.headers.get("authorization");
  if (h === "Bearer key-a") return { tenantId: "a" };
  if (h === "Bearer key-b") return { tenantId: "b" };
  return null;
};

const app = createApp({ authenticate: byHeader });

type Res = { status: number; body: any }; // oxlint-disable-line typescript/no-explicit-any

async function as(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  server: { handle: (r: Request) => Response | Promise<Response> } = app,
): Promise<Res> {
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  else if (method === "POST" || method === "PUT") init.body = "{}";
  const res = await server.handle(new Request(`http://alineod.test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Create a run as `token` and wait until its root has a sandbox. */
async function startAs(token: string, name = "root", extra: Record<string, unknown> = {}) {
  const res = await as(token, "POST", "/runs", { spec: spec(name, extra) });
  if (res.status !== 202) throw new Error(`POST /runs → ${res.status} ${JSON.stringify(res.body)}`);
  await until(
    async () => (await as(token, "GET", `/agents/${res.body.rootAgentId}`)).body?.sandboxId,
    "root to provision",
  );
  return { runId: res.body.runId as string, rootAgentId: res.body.rootAgentId as string };
}

// Every route that names a run or an agent. `:key` is filled in with "k".
const MATRIX: Array<[string, string]> = [
  ["GET", "/runs/:runId"],
  ["DELETE", "/runs/:runId"],
  ["GET", "/runs/:runId/events"],
  ["POST", "/runs/:runId/agents"],
  ["POST", "/runs/:runId/await"],
  ["GET", "/agents/:agentId"],
  ["GET", "/agents/:agentId/transcript"],
  ["POST", "/agents/:agentId/prompt"],
  ["POST", "/agents/:agentId/steer"],
  ["POST", "/agents/:agentId/pause"],
  ["POST", "/agents/:agentId/resume"],
  ["POST", "/agents/:agentId/stop"],
  ["POST", "/agents/:agentId/notify-on"],
  ["GET", "/agents/:agentId/inbox"],
  ["POST", "/agents/:agentId/inbox/deliver"],
  ["GET", "/agents/:agentId/result"],
  ["GET", "/agents/:agentId/await"],
  ["GET", "/agents/:agentId/memory"],
  ["GET", "/agents/:agentId/memory/:key"],
  ["PUT", "/agents/:agentId/memory/:key"],
  ["DELETE", "/agents/:agentId/memory/:key"],
  ["POST", "/agents/:agentId/facts"],
  ["GET", "/agents/:agentId/facts"],
  ["POST", "/agents/:agentId/compactions"],
];

// Routes that name no run or agent. `POST /runs` and `GET /runs` apply the tenant themselves.
const EXEMPT = new Set(["GET /health", "POST /runs/", "GET /runs/"]);

const fill = (path: string, runId: string, agentId: string) =>
  path.replace(":runId", runId).replace(":agentId", agentId).replace(":key", "k");

describe("route inventory", () => {
  test("every route is in the matrix, exempt, or part of the OpenAPI UI", () => {
    const covered = new Set(MATRIX.map(([m, p]) => `${m} ${p}`));
    const routes = app.routes;
    const unknown = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !covered.has(key) && !EXEMPT.has(key) && !key.includes(" /openapi"));
    expect(unknown).toEqual([]);
  });

  test("every matrix entry is a real route", () => {
    const routes = app.routes;
    const real = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(MATRIX.map(([m, p]) => `${m} ${p}`).filter((k) => !real.has(k))).toEqual([]);
  });
});

describe("a tenant cannot reach another tenant's run or agent", () => {
  let runId = "";
  let agentId = "";
  beforeAll(async () => {
    ({ runId, rootAgentId: agentId } = await startAs("key-a", "owned"));
  });

  for (const [method, template] of MATRIX) {
    test(`${method} ${template} is a 404 for tenant b, same as an id that does not exist`, async () => {
      const real = fill(template, runId, agentId);
      const missing = fill(template, "r_nope", "a_nope");
      const theirs = await as("key-b", method, real);
      const nothing = await as("key-b", method, missing);
      expect(theirs.status).toBe(404);
      // Identical but for the id the caller typed itself: nothing says the first one exists.
      expect(JSON.stringify(theirs.body).replace(runId, "X").replace(agentId, "X")).toBe(
        JSON.stringify(nothing.body).replace("r_nope", "X").replace("a_nope", "X"),
      );
    });
  }

  test("the owner still reaches its own run and agent", async () => {
    for (const path of [
      `/runs/${runId}`,
      `/agents/${agentId}`,
      `/agents/${agentId}/transcript`,
      `/agents/${agentId}/inbox`,
      `/agents/${agentId}/result`,
      `/agents/${agentId}/memory`,
    ]) {
      // 200, or 202 for a result that has not settled. Never a 404.
      expect([200, 202], path).toContain((await as("key-a", "GET", path)).status);
    }
  });

  test("tenant b cannot spawn into, await on or notify across tenant a's run", async () => {
    const mine = await startAs("key-b", "mine");
    const spawn = await as("key-b", "POST", `/runs/${mine.runId}/agents`, {
      spec: spec("sneak"),
      parentAgentId: agentId,
    });
    expect(spawn.status).toBe(404);
    const notify = await as("key-b", "POST", `/agents/${mine.rootAgentId}/notify-on`, {
      agents: [agentId],
    });
    expect(notify.status).toBe(400);
  });
});

describe("GET /runs", () => {
  test("lists only the caller's runs", async () => {
    const a = await startAs("key-a", "list-a");
    const b = await startAs("key-b", "list-b");
    const seenByA = (await as("key-a", "GET", "/runs")).body.runs.map(
      (r: { runId: string }) => r.runId,
    );
    const seenByB = (await as("key-b", "GET", "/runs")).body.runs.map(
      (r: { runId: string }) => r.runId,
    );
    expect(seenByA).toContain(a.runId);
    expect(seenByA).not.toContain(b.runId);
    expect(seenByB).toContain(b.runId);
    expect(seenByB).not.toContain(a.runId);
  });

  test("each row names the root, the state and when it started", async () => {
    const a = await startAs("key-a", "shape");
    const row = (await as("key-a", "GET", "/runs")).body.runs.find(
      (r: { runId: string }) => r.runId === a.runId,
    );
    expect(row).toEqual({
      runId: a.runId,
      rootAgentId: a.rootAgentId,
      state: "open",
      closeWhen: "explicit",
      createdAt: expect.any(Number),
    });
  });

  test("filters by state and rejects a bad limit or state", async () => {
    const a = await startAs("key-a", "closing");
    await as("key-a", "DELETE", `/runs/${a.runId}`);
    await until(
      async () => (await as("key-a", "GET", `/runs/${a.runId}`)).body.state === "closed",
      "close",
    );
    const open = (await as("key-a", "GET", "/runs?state=open")).body.runs;
    const closed = (await as("key-a", "GET", "/runs?state=closed")).body.runs;
    expect(open.map((r: { runId: string }) => r.runId)).not.toContain(a.runId);
    expect(closed.map((r: { runId: string }) => r.runId)).toContain(a.runId);
    expect((await as("key-a", "GET", "/runs?limit=0")).status).toBe(400);
    expect((await as("key-a", "GET", "/runs?limit=501")).status).toBe(400);
    expect((await as("key-a", "GET", "/runs?state=bogus")).status).toBe(400);
  });

  test("with no authentication it lists every run", async () => {
    const plain = createApp();
    const made = await as("x", "POST", "/runs", { spec: spec("anyone") }, plain);
    const listed = await as("x", "GET", "/runs", undefined, plain);
    expect(listed.body.runs.map((r: { runId: string }) => r.runId)).toContain(made.body.runId);
  });

  test("limit caps the rows", async () => {
    await startAs("key-a", "cap1");
    await startAs("key-a", "cap2");
    expect((await as("key-a", "GET", "/runs?limit=1")).body.runs).toHaveLength(1);
  });
});

describe("the tenant is part of the ledger", () => {
  test("a rebuild of the projections keeps it", async () => {
    const a = await startAs("key-a", "replay");
    expect(getRun(a.runId)?.tenant_id).toBe("a");
    rebuild();
    expect(getRun(a.runId)?.tenant_id).toBe("a");
    expect((await as("key-b", "GET", `/runs/${a.runId}`)).status).toBe(404);
    expect((await as("key-a", "GET", `/runs/${a.runId}`)).status).toBe(200);
  });

  test("a run made with no authentication has no tenant", async () => {
    const res = await callNoAuth("POST", "/runs", { spec: spec("untenanted") });
    expect(getRun(res.body.runId)?.tenant_id).toBeNull();
  });
});

describe("runs made before tenancy belong to the default tenant", () => {
  const token = createApp({ authenticate: tokenAuthenticate("s3cret") });

  test("a token holder can still reach a run made with no authentication", async () => {
    const res = await callNoAuth("POST", "/runs", { spec: spec("legacy") });
    expect((await as("s3cret", "GET", `/runs/${res.body.runId}`, undefined, token)).status).toBe(
      200,
    );
    const listed = await as("s3cret", "GET", "/runs", undefined, token);
    expect(listed.body.runs.map((r: { runId: string }) => r.runId)).toContain(res.body.runId);
  });

  test("a named tenant cannot", async () => {
    const res = await callNoAuth("POST", "/runs", { spec: spec("legacy2") });
    expect((await as("key-a", "GET", `/runs/${res.body.runId}`)).status).toBe(404);
  });

  test("a run a token holder creates is the default tenant's", async () => {
    const res = await as("s3cret", "POST", "/runs", { spec: spec("viatoken") }, token);
    expect(getRun(res.body.runId)?.tenant_id).toBe(DEFAULT_TENANT);
  });
});

describe("memory is scoped by tenant", () => {
  test("two tenants who pick the same name get different scopes", async () => {
    const a = await startAs("key-a", "same-name");
    const b = await startAs("key-b", "same-name");
    const refA = JSON.parse(getAgentRow(a.rootAgentId)!.spec_json) as { resourceId: string };
    const refB = JSON.parse(getAgentRow(b.rootAgentId)!.spec_json) as { resourceId: string };
    expect(refA.resourceId).toBe("a:same-name");
    expect(refB.resourceId).toBe("b:same-name");
  });

  test("a value written by one tenant is not read by the other", async () => {
    const a = await startAs("key-a", "shared-name");
    const b = await startAs("key-b", "shared-name");
    await as("key-a", "PUT", `/agents/${a.rootAgentId}/memory/note`, { value: "from a" });
    expect((await as("key-a", "GET", `/agents/${a.rootAgentId}/memory/note`)).body.value).toBe(
      "from a",
    );
    expect((await as("key-b", "GET", `/agents/${b.rootAgentId}/memory/note`)).status).toBe(404);
  });

  test("an explicit resourceId and teamId are prefixed too", async () => {
    const a = await startAs("key-a", "explicit", { resourceId: "mine", teamId: "crew" });
    const stored = JSON.parse(getAgentRow(a.rootAgentId)!.spec_json) as {
      resourceId: string;
      teamId: string;
    };
    expect(stored.resourceId).toBe("a:mine");
    expect(stored.teamId).toBe("a:crew");
  });

  test("a spawned child is prefixed as well", async () => {
    const a = await startAs("key-a", "parent");
    const res = await as("key-a", "POST", `/runs/${a.runId}/agents`, {
      spec: spec("kid"),
      parentAgentId: a.rootAgentId,
    });
    expect(res.status).toBe(202);
    const stored = JSON.parse(getAgentRow(res.body.agentId)!.spec_json) as { resourceId: string };
    expect(stored.resourceId).toBe("a:kid");
  });

  test("the default tenant and no authentication keep today's scope", async () => {
    const token = createApp({ authenticate: tokenAuthenticate("s3cret") });
    const res = await as("s3cret", "POST", "/runs", { spec: spec("plain") }, token);
    const stored = JSON.parse(getAgentRow(res.body.rootAgentId)!.spec_json) as {
      resourceId?: string;
    };
    expect(stored.resourceId).toBeUndefined();
  });
});

describe("memory scopes cannot collide across tenants", () => {
  const tokenApp = createApp({ authenticate: tokenAuthenticate("s3cret") });
  const asDefault = (extra: Record<string, unknown>) =>
    as("s3cret", "POST", "/runs", { spec: spec("d", extra) }, tokenApp);

  test("a default-tenant caller may not write a scope that looks like a named tenant's", async () => {
    for (const extra of [{ resourceId: "a:shared" }, { teamId: "a:crew" }, { name: "a:agent" }]) {
      const res = await asDefault(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  test("a default-tenant caller with ordinary ids is unaffected", async () => {
    expect((await asDefault({ resourceId: "shared", teamId: "crew" })).status).toBe(202);
  });

  test("a named tenant's colon in its own ids stays inside its prefix", async () => {
    const a = await startAs("key-a", "colon", { resourceId: "b:x" });
    const stored = JSON.parse(getAgentRow(a.rootAgentId)!.spec_json) as { resourceId: string };
    expect(stored.resourceId).toBe("a:b:x");
  });

  test("a tenant id with a colon, or an empty one, is refused as a credential", async () => {
    for (const tenantId of ["a:b", ""]) {
      const bad = createApp({ authenticate: () => ({ tenantId }) });
      expect((await as("x", "GET", "/runs", undefined, bad)).status, tenantId).toBe(401);
    }
  });
});

describe("spec env allowlist", () => {
  const guarded = createApp({
    authenticate: byHeader,
    specEnvAllow: ["NVIDIA_API_KEY", "OPENAI_*"],
  });
  const post = (env: unknown, path = "/runs", extra: Record<string, unknown> = {}) =>
    as("key-a", "POST", path, { spec: spec("g", { env }), ...extra }, guarded);

  test("a name that is not on the list is refused", async () => {
    const res = await post({ KEY: "${ALINEOD_BACKUP_SECRET_ACCESS_KEY}" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ALINEOD_BACKUP_SECRET_ACCESS_KEY");
  });

  test("an exact name and a prefix on the list pass", async () => {
    expect((await post({ KEY: "${NVIDIA_API_KEY}" })).status).toBe(202);
    expect((await post({ KEY: "${OPENAI_API_KEY}" })).status).toBe(202);
  });

  test("a literal value passes", async () => {
    expect((await post({ KEY: "sk-my-own-key" })).status).toBe(202);
  });

  test("a reference buried in a longer string is found", async () => {
    expect((await post({ URL: "https://x/?k=${ANTHROPIC_API_KEY}&y=1" })).status).toBe(400);
  });

  test("a credential binding is checked like a plain value", async () => {
    expect(
      (
        await post({
          KEY: {
            credential: "${ANTHROPIC_API_KEY}",
            host: "api.x.com",
            injection: { type: "header", name: "x-api-key" },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          KEY: {
            credential: "${NVIDIA_API_KEY}",
            host: "api.x.com",
            injection: { type: "header", name: "x-api-key" },
          },
        })
      ).status,
    ).toBe(202);
  });

  test("a prefix does not match a longer, different name", async () => {
    expect((await post({ KEY: "${NVIDIA_API_KEY_2}" })).status).toBe(400);
    expect((await post({ KEY: "${XOPENAI_API_KEY}" })).status).toBe(400);
  });

  test("an empty list allows no reference at all", async () => {
    const none = createApp({ authenticate: byHeader, specEnvAllow: [] });
    const refuse = await as(
      "key-a",
      "POST",
      "/runs",
      { spec: spec("g", { env: { K: "${HOME}" } }) },
      none,
    );
    expect(refuse.status).toBe(400);
    const literal = await as(
      "key-a",
      "POST",
      "/runs",
      { spec: spec("g", { env: { K: "x" } }) },
      none,
    );
    expect(literal.status).toBe(202);
  });

  test("a spawned child is checked too", async () => {
    const a = await startAs("key-a", "parent-g");
    const res = await as(
      "key-a",
      "POST",
      `/runs/${a.runId}/agents`,
      { spec: spec("kid", { env: { K: "${ANTHROPIC_API_KEY}" } }), parentAgentId: a.rootAgentId },
      createApp({ authenticate: byHeader, specEnvAllow: ["NVIDIA_API_KEY"] }),
    );
    expect(res.status).toBe(400);
  });

  test("with no list set, nothing is restricted", async () => {
    const res = await as("key-a", "POST", "/runs", {
      spec: spec("free", { env: { K: "${ANTHROPIC_API_KEY}" } }),
    });
    expect(res.status).toBe(202);
  });

  test("the list also applies with no authentication hook", async () => {
    const onlyList = createApp({ specEnvAllow: [] });
    const res = await as(
      "x",
      "POST",
      "/runs",
      { spec: spec("g", { env: { K: "${HOME}" } }) },
      onlyList,
    );
    expect(res.status).toBe(400);
  });
});

describe("run ids", () => {
  test("a new run id has 16 hex characters", async () => {
    const a = await startAs("key-a", "idlen");
    expect(a.runId).toMatch(/^r_[0-9a-f]{16}$/);
  });
});

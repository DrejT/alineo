/**
 * Per-tenant limits, the kill switch and the sweep. Everything is off until configured, so the
 * default case is covered by the rest of the suite passing unchanged.
 *
 * Each test uses its own tenant name, because the database is shared across the test files.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { sweepOnce } from "../src/engine/sweeper";
import { Limits, type LimitsOptions } from "../src/limits";
import type { Authenticate } from "../src/auth";
import { getRun } from "../src/state/projection";
import { spec, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

/** `Bearer <tenant>` is that tenant. */
const asTenant: Authenticate = (req) => {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ? { tenantId: m[1] } : null;
};

type Res = { status: number; body: { code?: string; error?: string; [k: string]: unknown } };

function serve(options: LimitsOptions) {
  const limits = new Limits(options);
  const app = createApp({ authenticate: asTenant, limits });
  const call = async (
    tenant: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Res> => {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${tenant}`, "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    else if (method === "POST" || method === "PUT") init.body = "{}";
    const res = await app.handle(new Request(`http://alineod.test${path}`, init));
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Res["body"]) : {} };
  };
  const start = async (tenant: string, name = "root") => {
    // A root with no spawn budget cannot spawn, and its children would fail as budget-exceeded.
    const res = await call(tenant, "POST", "/runs", {
      spec: spec(name, { spawnDepth: 3, maxAgents: 20 }),
    });
    if (res.status !== 202)
      throw new Error(`POST /runs → ${res.status} ${JSON.stringify(res.body)}`);
    const rootAgentId = res.body.rootAgentId as string;
    await until(
      async () => (await call(tenant, "GET", `/agents/${rootAgentId}`)).body.sandboxId,
      "provision",
    );
    return { runId: res.body.runId as string, rootAgentId };
  };
  const spawn = (tenant: string, runId: string, parent: string) =>
    call(tenant, "POST", `/runs/${runId}/agents`, { spec: spec("kid"), parentAgentId: parent });
  const closeRun = async (tenant: string, runId: string) => {
    await call(tenant, "DELETE", `/runs/${runId}`);
    await until(async () => getRun(runId)?.state === "closed", "run to close");
  };
  return { limits, app, call, start, spawn, closeRun };
}

describe("with no limits", () => {
  test("nothing is active and nothing is refused", async () => {
    const s = serve({ defaults: {} });
    expect(s.limits.active).toBe(false);
    expect(s.limits.needsSweep).toBe(false);
    for (let i = 0; i < 5; i++) await s.start("lim-none");
  });
});

describe("maxOpenRuns", () => {
  test("refuses the run past the limit with 429 LIMIT_EXCEEDED, for that tenant only", async () => {
    const s = serve({ defaults: { maxOpenRuns: 2 } });
    await s.start("lim-open-a");
    await s.start("lim-open-a");
    const third = await s.call("lim-open-a", "POST", "/runs", { spec: spec("x") });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("LIMIT_EXCEEDED");
    expect(third.body.error).toContain("2 runs are open");
    expect((await s.call("lim-open-b", "POST", "/runs", { spec: spec("x") })).status).toBe(202);
  });

  test("closing a run frees the slot", async () => {
    const s = serve({ defaults: { maxOpenRuns: 1 } });
    const first = await s.start("lim-open-free");
    expect((await s.call("lim-open-free", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
    await s.closeRun("lim-open-free", first.runId);
    expect((await s.call("lim-open-free", "POST", "/runs", { spec: spec("x") })).status).toBe(202);
  });

  test("a refused request creates nothing", async () => {
    const s = serve({ defaults: { maxOpenRuns: 1 } });
    await s.start("lim-open-none");
    await s.call("lim-open-none", "POST", "/runs", { spec: spec("x") });
    const listed = await s.call("lim-open-none", "GET", "/runs");
    expect((listed.body.runs as unknown[]).length).toBe(1);
  });
});

describe("maxLiveAgents", () => {
  test("counts the root and every spawn, and refuses past the limit", async () => {
    const s = serve({ defaults: { maxLiveAgents: 2 } });
    const run = await s.start("lim-live");
    expect((await s.spawn("lim-live", run.runId, run.rootAgentId)).status).toBe(202);
    const third = await s.spawn("lim-live", run.runId, run.rootAgentId);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("LIMIT_EXCEEDED");
  });

  test("is across runs, not per run", async () => {
    const s = serve({ defaults: { maxLiveAgents: 2 } });
    await s.start("lim-live-x");
    await s.start("lim-live-x");
    expect((await s.call("lim-live-x", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
  });

  test("closing the run frees the sandboxes", async () => {
    const s = serve({ defaults: { maxLiveAgents: 1 } });
    const run = await s.start("lim-live-free");
    expect((await s.call("lim-live-free", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
    await s.closeRun("lim-live-free", run.runId);
    expect((await s.call("lim-live-free", "POST", "/runs", { spec: spec("x") })).status).toBe(202);
  });
});

describe("maxAgentsPerWindow", () => {
  test("counts agents created, even after they are gone", async () => {
    const s = serve({ defaults: { maxAgentsPerWindow: { count: 2, windowMs: 3_600_000 } } });
    const run = await s.start("lim-win");
    await s.spawn("lim-win", run.runId, run.rootAgentId);
    await s.closeRun("lim-win", run.runId);
    const again = await s.call("lim-win", "POST", "/runs", { spec: spec("x") });
    expect(again.status).toBe(429);
    expect(again.body.error).toContain("created in the last");
  });

  test("is a rolling window: old agents stop counting", async () => {
    const s = serve({ defaults: { maxAgentsPerWindow: { count: 1, windowMs: 120 } } });
    await s.start("lim-roll");
    expect((await s.call("lim-roll", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
    await Bun.sleep(160);
    expect((await s.call("lim-roll", "POST", "/runs", { spec: spec("x") })).status).toBe(202);
  });
});

describe("limitsFor", () => {
  test("overrides the defaults for one tenant, field by field", async () => {
    const s = serve({
      defaults: { maxOpenRuns: 1, maxLiveAgents: 10 },
      limitsFor: (tenant) => (tenant === "lim-for-vip" ? { maxOpenRuns: 3 } : undefined),
    });
    await s.start("lim-for-vip");
    await s.start("lim-for-vip");
    await s.start("lim-for-vip");
    expect((await s.call("lim-for-vip", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
    await s.start("lim-for-plain");
    expect((await s.call("lim-for-plain", "POST", "/runs", { spec: spec("x") })).status).toBe(429);
  });

  test("may be async, and a function that throws refuses the request", async () => {
    const slow = serve({
      limitsFor: async () => {
        await Bun.sleep(5);
        return { maxOpenRuns: 1 };
      },
    });
    await slow.start("lim-for-async");
    expect((await slow.call("lim-for-async", "POST", "/runs", { spec: spec("x") })).status).toBe(
      429,
    );

    const broken = serve({
      limitsFor: () => {
        throw new Error("limit store down");
      },
    });
    const res = await broken.call("lim-for-broken", "POST", "/runs", { spec: spec("x") });
    expect(res.status).toBe(500);
    expect(await broken.call("lim-for-broken", "GET", "/runs")).toMatchObject({ status: 200 });
  });
});

describe("the check is atomic", () => {
  test("concurrent requests cannot all slip past the limit while it is being read", async () => {
    const s = serve({
      defaults: { maxOpenRuns: 2 },
      // The slow read is the gap a naive check-then-create would fall into.
      limitsFor: async () => {
        await Bun.sleep(15);
        return undefined;
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => s.call("lim-race", "POST", "/runs", { spec: spec("x") })),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
  });
});

describe("the kill switch", () => {
  const suspendedSet = new Set<string>();
  const s = serve({ isSuspended: (tenant) => suspendedSet.has(tenant) });

  test("refuses work that starts or continues, with 403 TENANT_SUSPENDED", async () => {
    const run = await s.start("kill-a");
    suspendedSet.add("kill-a");
    try {
      const attempts: Array<[string, string, unknown?]> = [
        ["POST", "/runs", { spec: spec("x") }],
        ["POST", `/runs/${run.runId}/agents`, { spec: spec("k"), parentAgentId: run.rootAgentId }],
        ["POST", `/agents/${run.rootAgentId}/prompt`, { text: "hi" }],
        ["POST", `/agents/${run.rootAgentId}/steer`, { message: "go" }],
        ["POST", `/agents/${run.rootAgentId}/resume`],
        ["PUT", `/agents/${run.rootAgentId}/memory/k`, { value: 1 }],
      ];
      for (const [method, path, body] of attempts) {
        const res = await s.call("kill-a", method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code).toBe("TENANT_SUSPENDED");
      }
    } finally {
      suspendedSet.delete("kill-a");
    }
  });

  test("still allows reads, stopping, pausing and waiting", async () => {
    const run = await s.start("kill-b");
    suspendedSet.add("kill-b");
    try {
      expect((await s.call("kill-b", "GET", `/runs/${run.runId}`)).status).toBe(200);
      expect((await s.call("kill-b", "GET", "/runs")).status).toBe(200);
      expect((await s.call("kill-b", "GET", `/agents/${run.rootAgentId}`)).status).toBe(200);
      expect((await s.call("kill-b", "POST", `/agents/${run.rootAgentId}/pause`)).status).toBe(202);
      expect(
        (await s.call("kill-b", "POST", `/runs/${run.runId}/await`, { subtree: run.rootAgentId }))
          .status,
      ).toBe(200);
      expect((await s.call("kill-b", "POST", `/agents/${run.rootAgentId}/stop`)).status).toBe(202);
      expect((await s.call("kill-b", "DELETE", `/runs/${run.runId}`)).status).toBe(204);
    } finally {
      suspendedSet.delete("kill-b");
    }
  });

  test("leaves other tenants alone", async () => {
    suspendedSet.add("kill-c");
    try {
      expect((await s.call("kill-d", "POST", "/runs", { spec: spec("x") })).status).toBe(202);
    } finally {
      suspendedSet.delete("kill-c");
    }
  });

  test("fails closed: a switch that throws refuses the write", async () => {
    const broken = serve({
      isSuspended: () => {
        throw new Error("switch store down");
      },
    });
    expect((await broken.call("kill-e", "POST", "/runs", { spec: spec("x") })).status).toBe(500);
    expect((await broken.call("kill-e", "GET", "/runs")).status).toBe(200);
  });
});

describe("the sweep", () => {
  test("tears down a run past its tenant's maxRunAgeMs and keeps a younger one", async () => {
    const s = serve({ defaults: { maxRunAgeMs: 60_000 } });
    const run = await s.start("sweep-age");
    expect(await sweepOnce(s.limits, Date.now() + 1_000)).toEqual([]);
    expect(getRun(run.runId)?.state).toBe("open");
    const torn = await sweepOnce(s.limits, Date.now() + 120_000);
    expect(torn.filter((t) => t.tenant === "sweep-age")).toEqual([
      { runId: run.runId, tenant: "sweep-age", reason: "age" },
    ]);
    expect(getRun(run.runId)?.state).toBe("closed");
  });

  test("keeps the ledger: the run can still be read afterward", async () => {
    const s = serve({ defaults: { maxRunAgeMs: 1_000 } });
    const run = await s.start("sweep-ledger");
    await sweepOnce(s.limits, Date.now() + 5_000);
    expect((await s.call("sweep-ledger", "GET", `/runs/${run.runId}`)).body.state).toBe("closed");
  });

  test("tears down every open run of a suspended tenant, and only that tenant", async () => {
    const suspended = new Set<string>();
    const s = serve({ isSuspended: (t) => suspended.has(t) });
    const a1 = await s.start("sweep-kill-a");
    const a2 = await s.start("sweep-kill-a");
    const b = await s.start("sweep-kill-b");
    suspended.add("sweep-kill-a");
    const torn = await sweepOnce(s.limits);
    expect(torn.filter((t) => t.tenant === "sweep-kill-a").map((t) => t.reason)).toEqual([
      "suspended",
      "suspended",
    ]);
    expect(getRun(a1.runId)?.state).toBe("closed");
    expect(getRun(a2.runId)?.state).toBe("closed");
    expect(getRun(b.runId)?.state).toBe("open");
  });

  test("a policy function that throws tears nothing down", async () => {
    const s = serve({});
    const run = await s.start("sweep-broken");
    const broken = new Limits({
      isSuspended: () => {
        throw new Error("down");
      },
    });
    await sweepOnce(broken);
    expect(getRun(run.runId)?.state).toBe("open");
  });

  test("with no age limit and no switch it does nothing", async () => {
    const s = serve({ defaults: {} });
    const run = await s.start("sweep-idle");
    expect(
      (await sweepOnce(s.limits, Date.now() + 10 * 86_400_000)).filter(
        (t) => t.tenant === "sweep-idle",
      ),
    ).toEqual([]);
    expect(getRun(run.runId)?.state).toBe("open");
  });

  test("honours a per-tenant age from limitsFor", async () => {
    const s = serve({
      limitsFor: (t) => (t === "sweep-short" ? { maxRunAgeMs: 1_000 } : undefined),
    });
    const short = await s.start("sweep-short");
    const long = await s.start("sweep-long");
    await sweepOnce(s.limits, Date.now() + 5_000);
    expect(getRun(short.runId)?.state).toBe("closed");
    expect(getRun(long.runId)?.state).toBe("open");
  });
});

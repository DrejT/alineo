/**
 * The memory layer, end to end: a real `Memory` over real SQLite (and real sqlite-vec for the
 * semantic half), driven through the real routes and the real start / spawn / rehydrate paths.
 * Only the SDK is faked — and `FakeAgent` reproduces the two bits of memory glue the real
 * `Alineo` has (`.memory` from `opts.memory`, and `spawn()` forking the parent's scope into the
 * child), so what these tests prove is that alineod hands the SDK what it needs to do that.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@alineo-labs/memory";
import {
  agentResourceRef,
  buildMemory,
  createEmbeddingProvider,
  getMemoryStore,
  installMemoryForTests,
  resetMemoryForTests,
  type MemoryStore,
} from "../src/engine/memory";
import { emit } from "../src/engine/emit";
import { backup } from "../src/ops/backup";
import { get } from "../src/engine/registry";
import { rehydrate } from "../src/engine/rehydrate";
import { newAgentId, newRunId } from "../src/ids";
import { call, spawnChild, spec, startRun, until, wipeState } from "./helpers";
import { FakeAgent, fakeSdk } from "./fakes";

beforeEach(() => wipeState());
afterEach(() => {
  fakeSdk.reset();
  resetMemoryForTests();
});

function tmpDb(name = "memory.db"): string {
  return join(mkdtempSync(join(tmpdir(), "alineod-memory-")), name);
}

/**
 * A deterministic stand-in for an embeddings model: a hashed bag of words. Two texts that share
 * words land near each other, which is all semantic recall needs to be observable in a test.
 */
function bagOfWords(): EmbeddingProvider & { calls: number } {
  const provider = {
    id: "bag-of-words",
    calls: 0,
    async embed(texts: string[]) {
      provider.calls++;
      return texts.map((t) => {
        const v = new Array<number>(64).fill(0);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
          let h = 0;
          for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
          v[h]! += 1;
        }
        return v;
      });
    },
  };
  return provider;
}

function semanticStore(opts: { maxFacts?: number; embeddings?: EmbeddingProvider } = {}): {
  store: MemoryStore;
  path: string;
} {
  const path = tmpDb();
  const store = buildMemory({ dbPath: path, embeddings: opts.embeddings ?? bagOfWords(), ...opts });
  installMemoryForTests(store);
  return { store, path };
}

async function newRoot(name: string, extra: Record<string, unknown> = {}) {
  const run = await startRun({ spec: spec(name, extra) });
  return { ...run, id: run.rootAgentId };
}

describe("createEmbeddingProvider", () => {
  function fakeFetch(handler: (req: { url: string; init: RequestInit; body: any }) => Response) {
    const seen: Array<{ url: string; init: RequestInit; body: any }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      const req = { url, init, body: JSON.parse(String(init.body)) };
      seen.push(req);
      return handler(req);
    }) as unknown as typeof fetch;
    return { fn, seen };
  }
  const ok = (vectors: number[][]) =>
    Response.json({ data: vectors.map((embedding, index) => ({ embedding, index })) });

  test("sends the model, the texts and the bearer token", async () => {
    const { fn, seen } = fakeFetch(() => ok([[1, 2]]));
    const provider = createEmbeddingProvider({
      url: "http://embed.test/v1/embeddings",
      model: "m1",
      apiKey: "sk-secret",
      timeoutMs: 1000,
      fetch: fn,
    });

    expect(await provider.embed(["hello"], { type: "passage" })).toEqual([[1, 2]]);

    expect(seen[0]!.url).toBe("http://embed.test/v1/embeddings");
    expect(seen[0]!.body).toEqual({ model: "m1", input: ["hello"] }); // no input_type unless asked
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-secret",
    );
  });

  test("sends no Authorization header without a key", async () => {
    const { fn, seen } = fakeFetch(() => ok([[1]]));
    await createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      timeoutMs: 1000,
      fetch: fn,
    }).embed(["x"]);
    expect(seen[0]!.init.headers).not.toHaveProperty("authorization");
  });

  test("asymmetric mode tells the model whether this is a stored passage or a query", async () => {
    const { fn, seen } = fakeFetch(() => ok([[1]]));
    const provider = createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      asymmetric: true,
      timeoutMs: 1000,
      fetch: fn,
    });
    await provider.embed(["a"], { type: "passage" });
    await provider.embed(["b"], { type: "query" });
    await provider.embed(["c"]); // unspecified: the recall-side default
    expect(seen.map((s) => s.body.input_type)).toEqual(["passage", "query", "query"]);
  });

  test("pairs vectors with texts by `index`, not by arrival order", async () => {
    const { fn } = fakeFetch(() =>
      Response.json({
        data: [
          { embedding: [2], index: 1 },
          { embedding: [1], index: 0 },
        ],
      }),
    );
    const provider = createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      timeoutMs: 1000,
      fetch: fn,
    });
    expect(await provider.embed(["first", "second"])).toEqual([[1], [2]]);
  });

  test("refuses a response it can't trust instead of storing garbage", async () => {
    const make = (data: unknown) =>
      createEmbeddingProvider({
        url: "http://e.test",
        model: "m",
        timeoutMs: 1000,
        fetch: fakeFetch(() => Response.json({ data })).fn,
      });

    await expect(make([{ embedding: [1], index: 0 }]).embed(["a", "b"])).rejects.toThrow(
      /expected 2 vectors, got 1/,
    );
    await expect(make([{ embedding: ["x"], index: 0 }]).embed(["a"])).rejects.toThrow(
      /not an array of numbers/,
    );
    await expect(make([{ embedding: [], index: 0 }]).embed(["a"])).rejects.toThrow(
      /not an array of numbers/,
    );
    await expect(make(undefined).embed(["a"])).rejects.toThrow(/got none/);
  });

  test("an HTTP error carries the status and a bounded body — and never the API key", async () => {
    const provider = createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      apiKey: "sk-secret",
      timeoutMs: 1000,
      fetch: fakeFetch(() => new Response("x".repeat(5000), { status: 429 })).fn,
    });
    const err = await provider.embed(["a"]).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/HTTP 429/);
    expect(err!.message.length).toBeLessThan(300);
    expect(err!.message).not.toContain("sk-secret");
  });

  test("a stalled provider times out rather than hanging the request", async () => {
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const provider = createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      timeoutMs: 30,
      fetch: hangs,
    });
    await expect(provider.embed(["a"])).rejects.toThrow(/timed out after 30ms/);
  });

  test("so does one that sends headers and then stalls mid-body", async () => {
    const stallsMidBody = ((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
            },
          }),
        ),
      )) as unknown as typeof fetch;
    const provider = createEmbeddingProvider({
      url: "http://e.test",
      model: "m",
      timeoutMs: 30,
      fetch: stallsMidBody,
    });
    await expect(provider.embed(["a"])).rejects.toThrow(/timed out after 30ms/);
  });
});

describe("agentResourceRef", () => {
  test("is resourceId, falling back to the spec name — the same rule as Alineo.resourceRef", () => {
    expect(agentResourceRef(JSON.stringify({ name: "n", resourceId: "r" }), "row")).toEqual({
      resourceId: "r",
    });
    expect(agentResourceRef(JSON.stringify({ name: "n" }), "row")).toEqual({ resourceId: "n" });
    expect(agentResourceRef(JSON.stringify({ name: "n", resourceId: "" }), "row")).toEqual({
      resourceId: "n",
    });
  });

  test("carries teamId only when set", () => {
    expect(agentResourceRef(JSON.stringify({ name: "n", teamId: "t" }), "row")).toEqual({
      resourceId: "n",
      teamId: "t",
    });
    expect(agentResourceRef(JSON.stringify({ name: "n", teamId: "" }), "row")).toEqual({
      resourceId: "n",
    });
  });

  test("a corrupt spec still scopes by the row's name rather than throwing", () => {
    expect(agentResourceRef("{not json", "row")).toEqual({ resourceId: "row" });
  });
});

describe("agents get the shared memory", () => {
  test("a root started through POST /runs has `.memory`, scoped by its spec", async () => {
    const { root } = await newRoot("scoped", { resourceId: "customer-7", teamId: "acme" });
    expect(root.memory).toBe(getMemoryStore()!.memory);
    expect(root.resourceRef).toEqual({ resourceId: "customer-7", teamId: "acme" });
  });

  test("memory disabled: agents start with no `.memory` and the routes say 501", async () => {
    installMemoryForTests(undefined);
    const { root, id } = await newRoot("nomem");
    expect(root.memory).toBeUndefined();

    for (const [method, path, body] of [
      ["GET", `/agents/${id}/memory`],
      ["PUT", `/agents/${id}/memory/k`, { value: 1 }],
      ["POST", `/agents/${id}/facts`, { content: "x" }],
      ["GET", `/agents/${id}/facts`],
      ["POST", `/agents/${id}/compactions`, {}],
    ] as const) {
      const res = await call(method, path, body);
      expect([method, path, res.status]).toEqual([method, path, 501]);
      expect(res.body.error).toMatch(/memory is disabled/);
    }
  });
});

describe("working memory routes", () => {
  test("set, get, list and delete a value", async () => {
    const { id } = await newRoot("wm-basic");

    const put = await call("PUT", `/agents/${id}/memory/plan`, {
      value: { tier: "pro", seats: [1, 2] },
    });
    expect(put).toMatchObject({
      status: 200,
      body: { key: "plan", value: { tier: "pro", seats: [1, 2] } },
    });

    expect((await call("GET", `/agents/${id}/memory/plan`)).body).toEqual({
      key: "plan",
      value: { tier: "pro", seats: [1, 2] },
    });
    const all = await call("GET", `/agents/${id}/memory`);
    expect(all.body).toEqual({
      agentId: id,
      resourceRef: { resourceId: "wm-basic" },
      semantic: false,
      working: { plan: { tier: "pro", seats: [1, 2] } },
    });

    expect((await call("DELETE", `/agents/${id}/memory/plan`)).status).toBe(204);
    expect((await call("DELETE", `/agents/${id}/memory/plan`)).status).toBe(204); // idempotent
    expect((await call("GET", `/agents/${id}/memory/plan`)).status).toBe(404);
    expect((await call("GET", `/agents/${id}/memory`)).body.working).toEqual({});
  });

  test("falsy-but-real values round-trip (0, false, empty string, null)", async () => {
    const { id } = await newRoot("wm-falsy");
    for (const value of [0, false, "", null]) {
      await call("PUT", `/agents/${id}/memory/k`, { value });
      expect((await call("GET", `/agents/${id}/memory/k`)).body.value).toBe(value);
    }
  });

  test("an unknown agent is 404", async () => {
    for (const [method, path, body] of [
      ["GET", "/agents/a_nope/memory"],
      ["GET", "/agents/a_nope/memory/k"],
      ["PUT", "/agents/a_nope/memory/k", { value: 1 }],
      ["DELETE", "/agents/a_nope/memory/k"],
      ["POST", "/agents/a_nope/facts", { content: "x" }],
      ["GET", "/agents/a_nope/facts"],
      ["POST", "/agents/a_nope/compactions", {}],
    ] as const) {
      expect([method, path, (await call(method, path, body)).status]).toEqual([method, path, 404]);
    }
  });

  test("rejects a missing, oversized or malformed value, and an over-long key", async () => {
    const { id } = await newRoot("wm-bad");

    expect((await call("PUT", `/agents/${id}/memory/k`, {})).status).toBe(400);
    expect(
      (await call("PUT", `/agents/${id}/memory/k`, { value: "x".repeat(70_000) })).status,
    ).toBe(400);
    const tooBig = await call("PUT", `/agents/${id}/memory/k`, { value: "x".repeat(70_000) });
    expect(tooBig.body.error).toMatch(/at most 65536 bytes/);

    const longKey = "k".repeat(257);
    expect((await call("PUT", `/agents/${id}/memory/${longKey}`, { value: 1 })).status).toBe(400);
    expect((await call("GET", `/agents/${id}/memory/${longKey}`)).status).toBe(400);

    // Nothing partial was written.
    expect((await call("GET", `/agents/${id}/memory`)).body.working).toEqual({});
  });

  test("keys with URL-special characters are stored under their decoded name", async () => {
    const { id } = await newRoot("wm-keys");
    const key = "user prefs/theme?";
    await call("PUT", `/agents/${id}/memory/${encodeURIComponent(key)}`, { value: "dark" });
    expect((await call("GET", `/agents/${id}/memory`)).body.working).toEqual({ [key]: "dark" });
  });
});

describe("scoping", () => {
  test("agents sharing a resourceId share memory; a different teamId does not", async () => {
    const a = await newRoot("scope-a", { resourceId: "shared" });
    const b = await newRoot("scope-b", { resourceId: "shared" });
    const team = await newRoot("scope-c", { resourceId: "shared", teamId: "team-1" });

    await call("PUT", `/agents/${a.id}/memory/fact`, { value: "from a" });

    expect((await call("GET", `/agents/${b.id}/memory/fact`)).body.value).toBe("from a");
    expect((await call("GET", `/agents/${team.id}/memory/fact`)).status).toBe(404);
  });

  test("agents with different names (the default resourceId) are isolated", async () => {
    const a = await newRoot("iso-a");
    const b = await newRoot("iso-b");
    await call("PUT", `/agents/${a.id}/memory/secret`, { value: 1 });
    expect((await call("GET", `/agents/${b.id}/memory`)).body.working).toEqual({});
  });
});

describe("a spawned child", () => {
  test("starts with a copy of its parent's memory, then diverges independently", async () => {
    const run = await startRun({ spec: spec("parent-mem", { spawnDepth: 2 }) });
    await call("PUT", `/agents/${run.rootAgentId}/memory/context`, { value: { goal: "ship" } });

    const child = await spawnChild(run.runId, run.rootAgentId, { spec: spec("child-mem") });

    // The SDK forked the parent's scope into the child's because alineod gave the parent a `.memory`.
    expect(child.agent.memory).toBe(run.root.memory);
    expect((await call("GET", `/agents/${child.agentId}/memory`)).body).toMatchObject({
      resourceRef: { resourceId: "child-mem" },
      working: { context: { goal: "ship" } },
    });

    await call("PUT", `/agents/${child.agentId}/memory/context`, { value: { goal: "changed" } });
    await call("PUT", `/agents/${child.agentId}/memory/only-child`, { value: true });
    expect((await call("GET", `/agents/${run.rootAgentId}/memory`)).body.working).toEqual({
      context: { goal: "ship" },
    });
  });

  test("copies semantic facts too", async () => {
    semanticStore();
    const run = await startRun({ spec: spec("parent-facts", { spawnDepth: 2 }) });
    await call("POST", `/agents/${run.rootAgentId}/facts`, {
      content: "the customer prefers email",
    });

    const child = await spawnChild(run.runId, run.rootAgentId, { spec: spec("child-facts") });

    const facts = (await call("GET", `/agents/${child.agentId}/facts`)).body.facts;
    expect(facts.map((f: { content: string }) => f.content)).toEqual([
      "the customer prefers email",
    ]);
  });
});

describe("durability", () => {
  test("memory stays readable after the agent has ended", async () => {
    const { id } = await newRoot("outlives");
    await call("PUT", `/agents/${id}/memory/k`, { value: "kept" });

    expect((await call("POST", `/agents/${id}/stop`)).status).toBe(202);
    await until(async () => (await call("GET", `/agents/${id}`)).body.outcome, "agent to end");

    expect((await call("GET", `/agents/${id}/memory/k`)).body.value).toBe("kept");
  });

  test("a new process opening the same file sees what the old one wrote", async () => {
    const path = tmpDb();
    const first = buildMemory({ dbPath: path });
    installMemoryForTests(first);
    const { id } = await newRoot("persists");
    await call("PUT", `/agents/${id}/memory/k`, { value: { n: 1 } });

    // A restart: the old connection is gone, a fresh store opens the same file.
    installMemoryForTests(buildMemory({ dbPath: path }));
    expect((await call("GET", `/agents/${id}/memory/k`)).body.value).toEqual({ n: 1 });
  });

  test("semantic facts persist across a restart too, and recall still works", async () => {
    const path = tmpDb();
    installMemoryForTests(buildMemory({ dbPath: path, embeddings: bagOfWords() }));
    const { id } = await newRoot("persists-facts");
    await call("POST", `/agents/${id}/facts`, { content: "alpha beta gamma" });
    await call("POST", `/agents/${id}/facts`, { content: "delta epsilon zeta" });

    installMemoryForTests(buildMemory({ dbPath: path, embeddings: bagOfWords() }));
    const recalled = await call(
      "GET",
      `/agents/${id}/facts?query=${encodeURIComponent("epsilon delta")}&topK=1`,
    );
    expect(recalled.body.facts.map((f: { content: string }) => f.content)).toEqual([
      "delta epsilon zeta",
    ]);
  });

  describe("rehydrate", () => {
    function seedAgent(runId: string, sandbox: FakeAgent, extraSpec: Record<string, unknown> = {}) {
      const id = newAgentId();
      emit(runId, id, "agent.spawned", {
        parentAgentId: null,
        runId,
        specName: sandbox.name,
        specJson: JSON.stringify(spec(sandbox.name, extraSpec)),
        depth: 0,
        spawnIndex: 0,
        sandboxId: null,
        spawnBudget: 2,
        maxAgentsBudget: null,
        waitFor: null,
        prompt: null,
      });
      emit(runId, id, "agent.provisioned", { sandboxId: sandbox.sandboxId });
      return id;
    }

    test("a reattached agent is handed the shared memory again", async () => {
      const runId = newRunId();
      const sandbox = new FakeAgent({ name: "rehy-reattach", runId });
      const id = seedAgent(runId, sandbox);

      await rehydrate();

      expect(get(id)).toBe(sandbox as never);
      expect(sandbox.memory).toBe(getMemoryStore()!.memory);
      expect(fakeSdk.calls.reattach).toEqual([sandbox.sandboxId]);
    });

    test("so is one that had to fall back to resume — and its memory is intact", async () => {
      const runId = newRunId();
      const sandbox = new FakeAgent({ name: "rehy-resume", runId });
      const id = seedAgent(runId, sandbox);
      await call("PUT", `/agents/${id}/memory/before-crash`, { value: "still here" });
      fakeSdk.reattachFails.add(sandbox.sandboxId);

      await rehydrate();

      expect(fakeSdk.calls.resume).toEqual([sandbox.sandboxId]);
      expect(sandbox.memory).toBe(getMemoryStore()!.memory);
      expect((await call("GET", `/agents/${id}/memory/before-crash`)).body.value).toBe(
        "still here",
      );
    });

    test("a rehydrated parent still forks its memory into the next child it spawns", async () => {
      const runId = newRunId();
      const sandbox = new FakeAgent({ name: "rehy-parent", runId });
      const id = seedAgent(runId, sandbox, { spawnDepth: 2 });
      await call("PUT", `/agents/${id}/memory/carry`, { value: "over" });

      await rehydrate();
      const child = await spawnChild(runId, id, { spec: spec("rehy-child") });

      expect((await call("GET", `/agents/${child.agentId}/memory/carry`)).body.value).toBe("over");
    });

    test("with memory disabled, reattached agents get none", async () => {
      installMemoryForTests(undefined);
      const runId = newRunId();
      const sandbox = new FakeAgent({ name: "rehy-off", runId });
      seedAgent(runId, sandbox);
      await rehydrate();
      expect(sandbox.memory).toBeUndefined();
    });
  });
});

describe("semantic memory routes", () => {
  test("without an embeddings endpoint, the facts routes are 501 and say what to set", async () => {
    const { id } = await newRoot("no-semantic");
    for (const [method, path, body] of [
      ["POST", `/agents/${id}/facts`, { content: "x" }],
      ["GET", `/agents/${id}/facts`],
      ["POST", `/agents/${id}/compactions`, {}],
    ] as const) {
      const res = await call(method, path, body);
      expect([method, res.status]).toEqual([method, 501]);
      expect(res.body.error).toMatch(/ALINEOD_MEMORY_EMBEDDINGS_URL/);
    }
    // Working memory is unaffected.
    expect((await call("GET", `/agents/${id}/memory`)).status).toBe(200);
  });

  test("remember, then recall by meaning", async () => {
    semanticStore();
    const { id } = await newRoot("sem-recall");
    const added = await call("POST", `/agents/${id}/facts`, {
      content: "customer owns a golden retriever dog",
    });
    expect(added).toMatchObject({ status: 201, body: { remembered: true, verified: false } });
    await call("POST", `/agents/${id}/facts`, { content: "invoice is due at the end of march" });
    await call("POST", `/agents/${id}/facts`, { content: "prefers contact by phone" });

    const res = await call(
      "GET",
      `/agents/${id}/facts?query=${encodeURIComponent("what dog does the customer own")}&topK=2`,
    );
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("what dog does the customer own");
    expect(res.body.facts).toHaveLength(2);
    expect(res.body.facts[0].content).toBe("customer owns a golden retriever dog");
  });

  test("`verified` is computed from sourceRef, never taken from the caller", async () => {
    semanticStore();
    const { id } = await newRoot("sem-verified");
    const withRef = await call("POST", `/agents/${id}/facts`, {
      content: "traceable fact",
      sourceRef: { sandboxId: "sb-1", entryIndex: 3 },
    });
    expect(withRef.body.verified).toBe(true);
    // A caller claiming `verified` in the body gets nothing for it: the field isn't in the schema.
    await call("POST", `/agents/${id}/facts`, { content: "untraceable fact", verified: true });

    const facts = (await call("GET", `/agents/${id}/facts`)).body.facts as Array<{
      content: string;
      verified: boolean;
      sourceRef?: unknown;
    }>;
    const byContent = Object.fromEntries(facts.map((f) => [f.content, f]));
    expect(byContent["traceable fact"]).toMatchObject({
      verified: true,
      sourceRef: { sandboxId: "sb-1", entryIndex: 3 },
    });
    expect(byContent["untraceable fact"]!.verified).toBe(false);
  });

  test("listing is newest-first, capped by ?limit, and carries ids", async () => {
    semanticStore();
    const { id } = await newRoot("sem-list");
    for (const content of ["one fact", "two fact", "three fact"]) {
      await call("POST", `/agents/${id}/facts`, { content });
      await Bun.sleep(5); // distinct rememberedAt
    }
    const all = (await call("GET", `/agents/${id}/facts`)).body;
    expect(all.query).toBeNull();
    expect(all.facts.map((f: { content: string }) => f.content)).toEqual([
      "three fact",
      "two fact",
      "one fact",
    ]);
    expect(all.facts.every((f: { id: string }) => typeof f.id === "string")).toBe(true);

    const limited = (await call("GET", `/agents/${id}/facts?limit=2`)).body.facts;
    expect(limited.map((f: { content: string }) => f.content)).toEqual(["three fact", "two fact"]);
  });

  test("validates its inputs", async () => {
    semanticStore();
    const { id } = await newRoot("sem-validate");
    expect((await call("POST", `/agents/${id}/facts`, { content: "" })).status).toBe(400);
    expect((await call("POST", `/agents/${id}/facts`, {})).status).toBe(400);
    expect((await call("POST", `/agents/${id}/facts`, { content: "x".repeat(9000) })).status).toBe(
      400,
    );
    expect(
      (await call("POST", `/agents/${id}/facts`, { content: "x", sourceRef: { sandboxId: "s" } }))
        .status,
    ).toBe(400);
    for (const q of ["topK=0", "topK=101", "topK=abc", "topK=1.5"]) {
      expect([q, (await call("GET", `/agents/${id}/facts?query=x&${q}`)).status]).toEqual([q, 400]);
    }
    expect((await call("GET", `/agents/${id}/facts?limit=0`)).status).toBe(400);
    expect((await call("POST", `/agents/${id}/compactions`, { maxFacts: -1 })).status).toBe(400);
  });

  test("a failing embeddings provider is a 502, not a 500 — and nothing is half-stored", async () => {
    let healthy = true;
    const flaky: EmbeddingProvider = {
      id: "flaky",
      async embed(texts) {
        if (!healthy) throw new Error("upstream exploded");
        return texts.map(() => [1, 0, 0]);
      },
    };
    semanticStore({ embeddings: flaky });
    const { id } = await newRoot("sem-flaky");
    await call("POST", `/agents/${id}/facts`, { content: "stored while healthy" });

    healthy = false;
    const add = await call("POST", `/agents/${id}/facts`, { content: "lost to the outage" });
    expect(add.status).toBe(502);
    expect(add.body.error).toMatch(/embeddings provider failed: upstream exploded/);
    expect((await call("GET", `/agents/${id}/facts?query=x`)).status).toBe(502);

    healthy = true;
    const facts = (await call("GET", `/agents/${id}/facts`)).body.facts;
    expect(facts.map((f: { content: string }) => f.content)).toEqual(["stored while healthy"]);
  });

  test("POST /compactions prunes to the cap, oldest first", async () => {
    semanticStore();
    const { id } = await newRoot("sem-compact");
    for (const content of ["fact a", "fact b", "fact c", "fact d"]) {
      await call("POST", `/agents/${id}/facts`, { content });
      await Bun.sleep(5);
    }

    const res = await call("POST", `/agents/${id}/compactions`, { maxFacts: 2 });
    expect(res).toMatchObject({ status: 200, body: { removed: 2, remaining: 2, summarized: 0 } });
    const left = (await call("GET", `/agents/${id}/facts`)).body.facts.map(
      (f: { content: string }) => f.content,
    );
    expect(left).toEqual(["fact d", "fact c"]);

    // No body at all is a valid no-op.
    expect((await call("POST", `/agents/${id}/compactions`)).body).toMatchObject({
      removed: 0,
      remaining: 2,
    });
  });

  test("auto-compaction (ALINEOD_MEMORY_MAX_FACTS) bounds growth with no operator action", async () => {
    semanticStore({ maxFacts: 2 });
    const { id } = await newRoot("sem-auto");
    for (const content of ["old one", "old two", "new three"]) {
      await call("POST", `/agents/${id}/facts`, { content });
      await Bun.sleep(5);
    }
    const left = (await call("GET", `/agents/${id}/facts`)).body.facts.map(
      (f: { content: string }) => f.content,
    );
    expect(left).toEqual(["new three", "old two"]);
  });

  test("facts are scoped per resource: one agent never recalls another's", async () => {
    semanticStore();
    const a = await newRoot("sem-iso-a");
    const b = await newRoot("sem-iso-b");
    await call("POST", `/agents/${a.id}/facts`, { content: "only a knows this" });

    expect((await call("GET", `/agents/${b.id}/facts`)).body.facts).toEqual([]);
    expect((await call("GET", `/agents/${b.id}/facts?query=knows`)).body.facts).toEqual([]);
  });
});

describe("backup", () => {
  test("captures working and semantic memory from a live store, and the copy is restorable", async () => {
    const { store, path } = semanticStore();
    const ref = { resourceId: "backed-up" };
    await store.memory.workingMemory.set(ref, "plan", "pro");
    await store.memory.remember(ref, { content: "alpha beta gamma" });
    await store.memory.remember(ref, { content: "delta epsilon zeta" });

    // The store is still open and writing — exactly the state a scheduled backup runs in. The
    // vectors live in a sqlite-vec `vec0` virtual table, which a plain SQLite connection can't
    // even read ("no such module: vec0"), so this also proves the backup loads the extension.
    const dir = mkdtempSync(join(tmpdir(), "alineod-memory-backup-"));
    const result = backup(
      {
        dbPath: join(dir, "absent.db"),
        sdkLedgerPath: join(dir, "absent-sdk.db"),
        memoryDbPath: path,
        workDir: join(dir, "absent-work"),
      },
      join(dir, "out"),
    );
    expect(result.databases).toHaveLength(1);
    expect(result.databases[0]).toMatchObject({ integrity: "ok" });
    expect(result.databases[0]!.tables).toMatchObject({
      alineo_working_memory: 1,
      alineo_semantic_memory: 2,
    });

    // Restore = open the copy.
    const restored = buildMemory({ dbPath: result.databases[0]!.file, embeddings: bagOfWords() });
    expect(await restored.memory.workingMemory.get(ref, "plan")).toBe("pro");
    const hits = await restored.memory.recall(ref, "epsilon delta", { topK: 1 });
    expect(hits.map((f) => f.content)).toEqual(["delta epsilon zeta"]);
  });

  test("a deployment that never created a memory file just skips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "alineod-memory-backup-"));
    const result = backup(
      {
        dbPath: join(dir, "a.db"),
        sdkLedgerPath: join(dir, "b.db"),
        memoryDbPath: join(dir, "never-created.db"),
        workDir: join(dir, "w"),
      },
      join(dir, "out"),
    );
    expect(result.databases).toEqual([]);
  });
});

test("the shared store is built lazily from config and reused", () => {
  resetMemoryForTests();
  const first = getMemoryStore();
  expect(first).toBeDefined();
  expect(getMemoryStore()).toBe(first);
  expect(first!.memory.hasSemanticMemory).toBe(false); // no embeddings endpoint in the test env
});

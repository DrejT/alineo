/**
 * End-to-end protocol tests: a real `@modelcontextprotocol/client` `Client` talks to our
 * `McpServer` over `InMemoryTransport.createLinkedPair()` — no module mocking, just the real
 * MCP wire protocol with a fake alineod behind `AlineodClient`'s injected `fetchImpl` seam.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.js";
import { writeConfig } from "@alineo-labs/cli-shared";
import { stubFetch } from "./fetch-stub.js";

const EXPECTED_TOOLS = [
  "run_start",
  "run_get",
  "run_stop",
  "run_watch",
  "agent_spawn",
  "agent_get",
  "agent_prompt",
  "agent_steer",
  "agent_pause",
  "agent_resume",
  "agent_stop",
  "result_get",
  "agent_await",
  "run_await",
  "transcript_get",
  "notify_add",
  "inbox_list",
  "inbox_deliver",
  "memory_list",
  "memory_get",
  "memory_set",
  "memory_remove",
  "fact_add",
  "fact_list",
  "compaction_start",
  "init",
  "spec_add",
  "spec_list",
  "spec_remove",
];

async function connectedClient(
  fetchImpl: typeof fetch,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer({ baseUrl: "http://test.local:4600", fetchImpl });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

describe("alineo-mcp server", () => {
  it("registers exactly the expected tool set", async () => {
    const { client, close } = await connectedClient(
      stubFetch(async () => new Response(null, { status: 204 })),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    } finally {
      await close();
    }
  });

  it("round-trips a successful run_start call", async () => {
    const fetchImpl = stubFetch(async (url, init) => {
      expect(String(url)).toBe("http://test.local:4600/runs");
      expect(JSON.parse(String(init?.body))).toEqual({
        spec: { name: "root", harness: "pi", model: "some-model" },
      });
      return new Response(
        JSON.stringify({ runId: "r1", rootAgentId: "a1", state: "provisioning" }),
        { status: 202 },
      );
    });
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({
        name: "run_start",
        arguments: { spec: { name: "root", harness: "pi", model: "some-model" } },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(JSON.parse(text)).toEqual({ runId: "r1", rootAgentId: "a1", state: "provisioning" });
    } finally {
      await close();
    }
  });

  it("surfaces an alineod error as an isError tool result, not a thrown protocol error", async () => {
    const fetchImpl = stubFetch(
      async () => new Response(JSON.stringify({ error: "no run r1" }), { status: 404 }),
    );
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({ name: "run_get", arguments: { runId: "r1" } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("no run r1");
    } finally {
      await close();
    }
  });

  it("adds the hint to the tool result when alineod sent one", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: "execd not ready",
            code: "EXEC_NOT_READY",
            hint: "check execd_image",
          }),
          { status: 500 },
        ),
    );
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({ name: "run_get", arguments: { runId: "r1" } });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toBe(
        "alineod error (500, EXEC_NOT_READY): execd not ready\nHint: check execd_image",
      );
    } finally {
      await close();
    }
  });

  it("names the error code in the tool result when alineod sent one", async () => {
    const fetchImpl = stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "agent is not live", code: "SANDBOX_NOT_RUNNING" }), {
          status: 409,
        }),
    );
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({ name: "run_get", arguments: { runId: "r1" } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("409, SANDBOX_NOT_RUNNING");
      expect(text).toContain("agent is not live");
    } finally {
      await close();
    }
  });

  it("flags a tool call missing a required argument before it reaches the handler", async () => {
    const fetchImpl = stubFetch(async () => new Response(null, { status: 204 }));
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({ name: "run_get", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("runId");
    } finally {
      await close();
    }
  });
});

type Seen = { method: string; url: string; body: unknown };

/** Connects a server whose fake alineod records every request and answers with `respond`. */
async function recording(respond: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl = stubFetch(async (url, init) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond();
  });
  return { seen, ...(await connectedClient(fetchImpl)) };
}

const json = (data: unknown, status = 200) => () =>
  new Response(JSON.stringify(data), { status });

const textOf = (r: { content?: unknown }) =>
  (r.content as { type: string; text: string }[])[0]?.text ?? "";

describe("alineo-mcp server wait, messaging and memory tools", () => {
  const B = "http://test.local:4600";

  it("agent_await long-polls the subtree endpoint", async () => {
    const { seen, client, close } = await recording(
      json({ rootAgentId: "a1", quiescent: true, members: [] }),
    );
    try {
      const r = await client.callTool({
        name: "agent_await",
        arguments: { agentId: "a1", waitSeconds: 30 },
      });
      expect(r.isError).toBeFalsy();
      expect(seen).toEqual([
        { method: "GET", url: `${B}/agents/a1/await?scope=subtree&wait=30`, body: undefined },
      ]);
    } finally {
      await close();
    }
  });

  it("run_await maps waitSeconds to wait and passes the regime through", async () => {
    const { seen, client, close } = await recording(
      json({ outcome: "satisfied", selected: ["a2"], settled: [], pending: [] }),
    );
    try {
      await client.callTool({
        name: "run_await",
        arguments: { runId: "r1", agents: ["a2", "a3"], mode: "any", waitSeconds: 10 },
      });
      expect(seen).toEqual([
        {
          method: "POST",
          url: `${B}/runs/r1/await`,
          body: { agents: ["a2", "a3"], mode: "any", wait: 10 },
        },
      ]);
    } finally {
      await close();
    }
  });

  it("transcript_get asks for the full transcript only when told to", async () => {
    const { seen, client, close } = await recording(json({ messages: [] }));
    try {
      await client.callTool({ name: "transcript_get", arguments: { agentId: "a1" } });
      await client.callTool({ name: "transcript_get", arguments: { agentId: "a1", full: true } });
      expect(seen.map((s) => s.url)).toEqual([
        `${B}/agents/a1/transcript`,
        `${B}/agents/a1/transcript?full=1`,
      ]);
    } finally {
      await close();
    }
  });

  it("notify_add, inbox_list and inbox_deliver hit the messaging routes", async () => {
    const { seen, client, close } = await recording(json({}));
    try {
      await client.callTool({
        name: "notify_add",
        arguments: { agentId: "a1", agents: ["a2"], wake: true },
      });
      await client.callTool({ name: "inbox_list", arguments: { agentId: "a1" } });
      await client.callTool({ name: "inbox_deliver", arguments: { agentId: "a1" } });
      expect(seen).toEqual([
        {
          method: "POST",
          url: `${B}/agents/a1/notify-on`,
          body: { agents: ["a2"], wake: true },
        },
        { method: "GET", url: `${B}/agents/a1/inbox`, body: undefined },
        { method: "POST", url: `${B}/agents/a1/inbox/deliver`, body: undefined },
      ]);
    } finally {
      await close();
    }
  });

  it("memory tools URL-encode the key and wrap the value", async () => {
    const { seen, client, close } = await recording(json({ key: "a/b", value: 1 }));
    try {
      await client.callTool({
        name: "memory_set",
        arguments: { agentId: "a1", key: "a/b", value: { n: 1 } },
      });
      await client.callTool({ name: "memory_get", arguments: { agentId: "a1", key: "a/b" } });
      await client.callTool({
        name: "memory_list",
        arguments: { agentId: "a1", limit: 5, after: "k" },
      });
      expect(seen).toEqual([
        { method: "PUT", url: `${B}/agents/a1/memory/a%2Fb`, body: { value: { n: 1 } } },
        { method: "GET", url: `${B}/agents/a1/memory/a%2Fb`, body: undefined },
        { method: "GET", url: `${B}/agents/a1/memory?limit=5&after=k`, body: undefined },
      ]);
    } finally {
      await close();
    }
  });

  it("memory_remove treats a 204 as success", async () => {
    const { seen, client, close } = await recording(() => new Response(null, { status: 204 }));
    try {
      const r = await client.callTool({
        name: "memory_remove",
        arguments: { agentId: "a1", key: "k" },
      });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain("'k' removed");
      expect(seen).toEqual([{ method: "DELETE", url: `${B}/agents/a1/memory/k`, body: undefined }]);
    } finally {
      await close();
    }
  });

  it("fact_add, fact_list and compaction_start hit the semantic-memory routes", async () => {
    const { seen, client, close } = await recording(json({}));
    try {
      await client.callTool({
        name: "fact_add",
        arguments: { agentId: "a1", content: "x", sourceRef: { sandboxId: "s", entryIndex: 2 } },
      });
      await client.callTool({
        name: "fact_list",
        arguments: { agentId: "a1", query: "hello world", topK: 3 },
      });
      await client.callTool({ name: "fact_list", arguments: { agentId: "a1" } });
      await client.callTool({
        name: "compaction_start",
        arguments: { agentId: "a1", maxFacts: 10 },
      });
      expect(seen).toEqual([
        {
          method: "POST",
          url: `${B}/agents/a1/facts`,
          body: { content: "x", sourceRef: { sandboxId: "s", entryIndex: 2 } },
        },
        { method: "GET", url: `${B}/agents/a1/facts?query=hello+world&topK=3`, body: undefined },
        { method: "GET", url: `${B}/agents/a1/facts`, body: undefined },
        { method: "POST", url: `${B}/agents/a1/compactions`, body: { maxFacts: 10 } },
      ]);
    } finally {
      await close();
    }
  });

  it("pause, resume, stop and steer send scope only when given, and return the subtree result", async () => {
    const { seen, client, close } = await recording(json({ asOf: 1, results: [] }, 200));
    try {
      const r = await client.callTool({
        name: "agent_stop",
        arguments: { agentId: "a1", scope: "subtree" },
      });
      expect(JSON.parse(textOf(r))).toEqual({ asOf: 1, results: [] });
      await client.callTool({ name: "agent_pause", arguments: { agentId: "a1" } });
      await client.callTool({
        name: "agent_steer",
        arguments: { agentId: "a1", message: "go", scope: "subtree" },
      });
      expect(seen.map((s) => s.body)).toEqual([
        { scope: "subtree" },
        undefined,
        { message: "go", scope: "subtree" },
      ]);
    } finally {
      await close();
    }
  });

  it("a 202 from a single-agent control reads as a plain acknowledgement", async () => {
    const { client, close } = await recording(() => new Response(null, { status: 202 }));
    try {
      const r = await client.callTool({ name: "agent_pause", arguments: { agentId: "a1" } });
      expect(textOf(r)).toBe("Agent a1 pausing.");
    } finally {
      await close();
    }
  });

  it("run_await rejects a call that names neither agents nor subtree via alineod's 400", async () => {
    const { client, close } = await recording(
      json({ error: "give exactly one of agents or subtree", code: "INVALID_ARGUMENT" }, 400),
    );
    try {
      const r = await client.callTool({ name: "run_await", arguments: { runId: "r1" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("give exactly one of agents or subtree");
    } finally {
      await close();
    }
  });
});

describe("alineo-mcp server local spec tools", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "alineo-mcp-server-test-"));
    process.chdir(tempDir);
    // Keeps readConfig() off its global-fallback branch (~/.config/alineo) — see specs.test.ts.
    await writeConfig({
      provider: "opensandbox",
      serverUrl: "http://127.0.0.1:8080",
      useServerProxy: true,
      apiKey: "",
      adapterPath: "./.alineo/ledger.db",
      agentsDir: "./agents",
      defaults: { resources: { cpu: "1000m", memory: "1Gi" } },
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("adds, lists, and removes a spec entirely over the protocol", async () => {
    const source = join(tempDir, "spec.json");
    await Bun.write(
      source,
      JSON.stringify({ name: "reviewer", harness: "pi", model: "some-model" }),
    );

    const { client, close } = await connectedClient(
      stubFetch(async () => new Response(null, { status: 204 })),
    );
    try {
      const added = await client.callTool({
        name: "spec_add",
        arguments: { url: source },
      });
      expect(added.isError).toBeFalsy();

      const listed = await client.callTool({ name: "spec_list", arguments: {} });
      const specs = JSON.parse(
        (listed.content as { type: string; text: string }[])[0]?.text ?? "[]",
      ) as { name: string }[];
      expect(specs.map((s) => s.name)).toEqual(["reviewer"]);

      const removed = await client.callTool({
        name: "spec_remove",
        arguments: { name: "reviewer" },
      });
      expect(removed.isError).toBeFalsy();

      const listedAfter = await client.callTool({ name: "spec_list", arguments: {} });
      expect(
        JSON.parse((listedAfter.content as { type: string; text: string }[])[0]?.text ?? "[]"),
      ).toEqual([]);
    } finally {
      await close();
    }
  });
});

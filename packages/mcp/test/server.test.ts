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
  "alineod_create_run",
  "alineod_get_run",
  "alineod_delete_run",
  "alineod_watch_events",
  "alineod_spawn_agent",
  "alineod_get_agent",
  "alineod_prompt_agent",
  "alineod_steer_agent",
  "alineod_pause_agent",
  "alineod_resume_agent",
  "alineod_stop_agent",
  "alineod_get_result",
  "alineo_init",
  "alineo_add_spec",
  "alineo_list_specs",
  "alineo_remove_spec",
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

  it("round-trips a successful alineod_create_run call", async () => {
    const fetchImpl = stubFetch(async (url, init) => {
      expect(String(url)).toBe("http://test.local:4600/runs");
      expect(JSON.parse(String(init?.body))).toEqual({
        spec: { name: "root", cli: "pi", model: "some-model" },
      });
      return new Response(
        JSON.stringify({ runId: "r1", rootAgentId: "a1", state: "provisioning" }),
        { status: 202 },
      );
    });
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({
        name: "alineod_create_run",
        arguments: { spec: { name: "root", cli: "pi", model: "some-model" } },
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
      const result = await client.callTool({ name: "alineod_get_run", arguments: { runId: "r1" } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("no run r1");
    } finally {
      await close();
    }
  });

  it("flags a tool call missing a required argument before it reaches the handler", async () => {
    const fetchImpl = stubFetch(async () => new Response(null, { status: 204 }));
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({ name: "alineod_get_run", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("runId");
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
    await Bun.write(source, JSON.stringify({ name: "reviewer", cli: "pi", model: "some-model" }));

    const { client, close } = await connectedClient(
      stubFetch(async () => new Response(null, { status: 204 })),
    );
    try {
      const added = await client.callTool({
        name: "alineo_add_spec",
        arguments: { url: source },
      });
      expect(added.isError).toBeFalsy();

      const listed = await client.callTool({ name: "alineo_list_specs", arguments: {} });
      const specs = JSON.parse(
        (listed.content as { type: string; text: string }[])[0]?.text ?? "[]",
      ) as { name: string }[];
      expect(specs.map((s) => s.name)).toEqual(["reviewer"]);

      const removed = await client.callTool({
        name: "alineo_remove_spec",
        arguments: { name: "reviewer" },
      });
      expect(removed.isError).toBeFalsy();

      const listedAfter = await client.callTool({ name: "alineo_list_specs", arguments: {} });
      expect(
        JSON.parse((listedAfter.content as { type: string; text: string }[])[0]?.text ?? "[]"),
      ).toEqual([]);
    } finally {
      await close();
    }
  });
});

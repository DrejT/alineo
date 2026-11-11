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
  "run_list",
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
  "init",
  "spec_add",
  "spec_list",
  "spec_get",
  "spec_remove",
];

async function connectedClient(
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof buildServer>[0]> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer({ baseUrl: "http://test.local:4600", fetchImpl, ...extra });
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

  it("round-trips run_list", async () => {
    const fetchImpl = stubFetch(async (url) => {
      expect(String(url)).toBe("http://test.local:4600/runs?limit=2&state=open");
      return new Response(
        JSON.stringify({
          runs: [
            { runId: "r1", rootAgentId: "a1", state: "open", closeWhen: "explicit", createdAt: 1 },
          ],
        }),
        { status: 200 },
      );
    });
    const { client, close } = await connectedClient(fetchImpl);
    try {
      const result = await client.callTool({
        name: "run_list",
        arguments: { limit: 2, state: "open" },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect((JSON.parse(text) as { runs: Array<{ runId: string }> }).runs[0]?.runId).toBe("r1");
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

describe("alineo-mcp server in remote mode", () => {
  const idle = () => stubFetch(async () => new Response(null, { status: 204 }));
  const textOf = (result: { content?: unknown }) =>
    (result.content as { type: string; text: string }[])[0]?.text ?? "";
  const validSpec = { name: "writer", harness: "pi", model: "some-model" };

  it("has every tool except init", async () => {
    const { client, close } = await connectedClient(idle(), { mode: "remote" });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS.filter((t) => t !== "init").sort());
    } finally {
      await close();
    }
  });

  it("keeps init in local mode", async () => {
    const { client, close } = await connectedClient(idle(), { mode: "local" });
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("init");
    } finally {
      await close();
    }
  });

  it("takes an inline spec, then lists, gets and removes it", async () => {
    const { client, close } = await connectedClient(idle(), { mode: "remote" });
    try {
      const added = await client.callTool({ name: "spec_add", arguments: { spec: validSpec } });
      expect(added.isError).toBeFalsy();
      expect((JSON.parse(textOf(added)) as { name: string }).name).toBe("writer");

      const listed = await client.callTool({ name: "spec_list", arguments: {} });
      expect(JSON.parse(textOf(listed))).toEqual([
        { name: "writer", harness: "pi", description: "" },
      ]);

      const got = await client.callTool({ name: "spec_get", arguments: { name: "writer" } });
      expect((JSON.parse(textOf(got)) as { model: string }).model).toBe("some-model");

      const removed = await client.callTool({ name: "spec_remove", arguments: { name: "writer" } });
      expect(removed.isError).toBeFalsy();
      const gone = await client.callTool({ name: "spec_get", arguments: { name: "writer" } });
      expect(gone.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("refuses a local file path and does not read it", async () => {
    const { client, close } = await connectedClient(idle(), { mode: "remote" });
    try {
      for (const url of ["/etc/passwd", "file:///etc/passwd", "../secrets.json"]) {
        const result = await client.callTool({ name: "spec_add", arguments: { url } });
        expect(result.isError, url).toBe(true);
        expect(textOf(result), url).not.toContain("root:");
      }
    } finally {
      await close();
    }
  });

  it("refuses a URL aimed at the server's own network", async () => {
    const fetchImpl = idle();
    const { client, close } = await connectedClient(fetchImpl, { mode: "remote" });
    try {
      for (const url of [
        "https://127.0.0.1/v1/sandboxes",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/x",
        "http://example.com/spec.json",
      ]) {
        const result = await client.callTool({ name: "spec_add", arguments: { url } });
        expect(result.isError, url).toBe(true);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("needs exactly one of spec and url", async () => {
    const { client, close } = await connectedClient(idle(), { mode: "remote" });
    try {
      expect((await client.callTool({ name: "spec_add", arguments: {} })).isError).toBe(true);
      expect(
        (
          await client.callTool({
            name: "spec_add",
            arguments: { spec: validSpec, url: "https://example.com/a.json" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("uses the store it is given", async () => {
    const { MemorySpecStore } = await import("../src/spec-store.js");
    const store = new MemorySpecStore();
    const { client, close } = await connectedClient(idle(), { mode: "remote", specs: store });
    try {
      await client.callTool({ name: "spec_add", arguments: { spec: validSpec } });
      expect((await store.get("writer"))?.name).toBe("writer");
    } finally {
      await close();
    }
  });
});

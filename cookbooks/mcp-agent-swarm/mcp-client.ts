/**
 * Connects to alineo-mcp over stdio and gives back a tiny `call(tool, args)` helper that parses
 * the JSON-RPC tool result the way the recipe wants it: the text content parsed as JSON when it
 * looks like JSON, the raw string otherwise, and a thrown error when the server set `isError`.
 *
 * This is the same connection shape a chat client (Claude Code, Claude Desktop, Cursor) uses
 * when it launches alineo-mcp from an `mcpServers` config — see ../../packages/mcp/README.md's
 * "Configure a client" section for those. Here we're the client instead, scripted.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// The SDK's own default request timeout (60s) is too tight for this recipe: several tools here
// long-poll server-side on their own bound (result_get's waitSeconds,
// run_watch's maxWaitSeconds, agent_spawn's waitFor) that can legitimately
// exceed 60s under real model latency — a real run hit the default ceiling at three different
// call sites in a row. Give every call real headroom by default; a caller can still pass a
// longer timeoutMs for a specific call expected to run past this.
const DEFAULT_TIMEOUT_MS = 150_000; // headroom above result_get's own 120s waitSeconds default

export interface AlineoMcpConnection {
  // eslint-disable-next-line typescript/no-explicit-any -- recipe-local, untyped like swarm-code-review's api()
  call(tool: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any>;
  close(): Promise<void>;
}

export async function connectAlineoMcp(opts: {
  /** Path to the built alineo-mcp entry point (packages/mcp/dist/index.mjs). */
  serverPath: string;
  alineodUrl?: string;
}): Promise<AlineoMcpConnection> {
  const client = new Client({ name: "mcp-agent-swarm-cookbook", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: [opts.serverPath],
    env: opts.alineodUrl ? { ALINEOD_URL: opts.alineodUrl } : undefined,
  });
  await client.connect(transport);

  return {
    async call(tool, args = {}, opts) {
      const result = await client.callTool(
        { name: tool, arguments: args },
        { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      );
      const content = result.content as { type: string; text: string }[];
      const text = content[0]?.text ?? "";
      if (result.isError) throw new Error(`${tool} → ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

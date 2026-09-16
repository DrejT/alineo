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

export interface AlineoMcpConnection {
  call(tool: string, args?: Record<string, unknown>): Promise<any>; // eslint-disable-line typescript/no-explicit-any -- recipe-local, untyped like swarm-code-review's api()
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
    async call(tool, args = {}) {
      const result = await client.callTool({ name: tool, arguments: args });
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

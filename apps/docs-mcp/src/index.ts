import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listDocs, getDoc, searchDocs } from "./docs";

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "alineo-docs", version: "1.0.0" },
    {
      instructions:
        "Search and read the alineo documentation (docs.alineo.tech). alineo is an " +
        "AI agent platform built on sandboxed execution. Use `search_docs` to find " +
        "relevant pages, then `get_doc` to read one in full. `list_docs` returns the " +
        "whole page index. This server is read-only and covers documentation only — " +
        "it does not run or orchestrate sandboxes.",
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search alineo docs",
      description:
        "Search the alineo documentation. Returns the best-matching pages with their " +
        "title, canonical URL, description, and a matching snippet.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Natural-language or keyword query"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
      }),
    },
    async ({ query, limit }) => ({
      content: [{ type: "text", text: await searchDocs(query, limit ?? 5) }],
    }),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Read an alineo docs page",
      description:
        "Fetch the full Markdown of one alineo documentation page. Accepts a canonical " +
        "URL, a `/docs/...` path, or a `collection/slug` pair (from search_docs results).",
      inputSchema: z.object({
        path: z.string().min(1).describe("e.g. /docs/core/getting-started or core/getting-started"),
      }),
    },
    async ({ path }) => {
      const doc = await getDoc(path);
      return doc
        ? { content: [{ type: "text", text: doc }] }
        : { content: [{ type: "text", text: `No docs page found for "${path}".` }], isError: true };
    },
  );

  server.registerTool(
    "list_docs",
    {
      title: "List alineo docs pages",
      description:
        "Return the full index of alineo documentation pages — title, URL, and " +
        "description for every page. Use to browse or when a search is too narrow.",
      inputSchema: z.object({}),
    },
    async () => ({ content: [{ type: "text", text: await listDocs() }] }),
  );

  return server;
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // A friendly landing page for humans who open the URL in a browser.
    if (
      request.method === "GET" &&
      (path === "/mcp" || path === "") &&
      !request.headers.get("accept")?.includes("text/event-stream")
    ) {
      return withCors(
        new Response(
          "alineo docs MCP server\n\n" +
            "Add this endpoint to an MCP client:\n\n" +
            `  ${url.origin}/mcp\n\n` +
            "Tools: search_docs, get_doc, list_docs\n" +
            "Docs:  https://docs.alineo.tech/docs/core/ai-resources\n",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        ),
      );
    }

    return withCors(await handler.fetch(request));
  },
};

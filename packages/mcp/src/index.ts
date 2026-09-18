#!/usr/bin/env bun
/**
 * Entry point: serves the MCP server built in server.ts over stdio, the transport an MCP
 * client (Claude Code, Claude Desktop, Cursor, …) launches this process with. stdout is the
 * JSON-RPC channel here — nothing in this package may `console.log`; use console.error (stderr)
 * for anything diagnostic.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

serveStdio(() => buildServer(), {
  onerror: (err) => {
    console.error(`[alineo-mcp] ${err.message}`);
  },
});

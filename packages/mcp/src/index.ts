#!/usr/bin/env bun
/**
 * Entry point. By default it serves the MCP server built in server.ts over stdio, the transport an MCP
 * client (Claude Code, Claude Desktop, Cursor, …) launches this process with. stdout is the
 * JSON-RPC channel here — nothing in this package may `console.log`; use console.error (stderr)
 * for anything diagnostic.
 *
 * `--http [--port N] [--host H] [--allow-anonymous]` serves it over streamable HTTP for other
 * people instead. See http.ts.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serveHttp } from "./http.js";
import { buildServer } from "./server.js";

/** `--name value`, or `undefined` when the flag is absent. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** A TCP port, or an exit with a message. `undefined` when the flag is absent. */
function portFlag(): number | undefined {
  const raw = flag("--port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    // oxlint-disable-next-line no-console
    console.error(`[alineo-mcp] --port needs a whole number from 0 to 65535, got '${raw}'`);
    process.exit(2);
  }
  return port;
}

if (process.argv.includes("--http")) {
  // Served to other people: streamable HTTP, remote mode. See http.ts for what that changes.
  const { port } = serveHttp({
    port: portFlag(),
    hostname: flag("--host"),
    requireAuthorization: !process.argv.includes("--allow-anonymous"),
  });
  // stderr, like every diagnostic in this package.
  // oxlint-disable-next-line no-console
  console.error(`[alineo-mcp] serving streamable HTTP on port ${port}`);
} else {
  serveStdio(() => buildServer(), {
    onerror: (err) => {
      // Deliberately not the logger (silent by default — a transport error must always surface):
      // stderr is the only safe channel because stdout is the JSON-RPC stream.
      // oxlint-disable-next-line no-console
      console.error(`[alineo-mcp] ${err.message}`);
    },
  });
}

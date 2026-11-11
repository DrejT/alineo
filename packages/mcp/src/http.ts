/**
 * Serve the MCP over streamable HTTP, for other people. The stdio server in `index.ts` runs on one
 * user's machine and trusts them. This one does not trust the caller, and it holds no credential
 * of its own:
 *
 * - It forwards each caller's own `Authorization` header to alineod. alineod's `authenticate`
 *   hook then decides who the caller is and which runs they may see. The MCP stays stateless and
 *   identity lives in one place.
 * - By default a request with no `Authorization` header is refused here, so the endpoint is not
 *   an open door to an alineod that has no authentication. Turn that off only when alineod itself
 *   does the checking and you want it to answer.
 * - It builds the server in `remote` mode: no `init`, no local files, specs in a `SpecStore`.
 *
 * Stateless: every request builds a fresh server, so any number of instances can sit behind a
 * load balancer with no shared session.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, type BuildServerOptions } from "./server.js";
import type { SpecStore } from "./spec-store.js";

export interface HttpMcpOptions extends Omit<
  BuildServerOptions,
  "mode" | "authorization" | "apiKey" | "specs"
> {
  /** Refuse a request with no `Authorization` header. Default `true`. */
  requireAuthorization?: boolean;
  /**
   * Which store holds this caller's specs. Receives the caller's `Authorization` header value, so
   * a deployer can keep one store per user. Default: a fresh in-memory store per request, which
   * means a spec added in one request is gone in the next. Pass a store that persists, per user.
   */
  specsFor?: (authorization: string | undefined) => SpecStore | undefined;
}

export interface HttpMcp {
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
}

function unauthorized(): Response {
  return Response.json(
    { error: "An Authorization header is required.", code: "UNAUTHENTICATED" },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

export function createHttpMcp(options: HttpMcpOptions = {}): HttpMcp {
  const { requireAuthorization = true, specsFor, ...serverOptions } = options;

  const handler = createMcpHandler((ctx) => {
    // `authInfo.token` carries the caller's whole header value. It is the handler's per-request
    // channel, and the only one a server factory can see.
    const authorization = ctx.authInfo?.token;
    return buildServer({
      ...serverOptions,
      mode: "remote",
      authorization: () => authorization,
      specs: specsFor?.(authorization),
    });
  });

  return {
    async fetch(request) {
      const authorization = request.headers.get("authorization") ?? undefined;
      if (requireAuthorization && !authorization) return unauthorized();
      return handler.fetch(
        request,
        authorization
          ? { authInfo: { token: authorization, clientId: "authorization-header", scopes: [] } }
          : undefined,
      );
    },
    close: () => handler.close(),
  };
}

export interface ServeHttpOptions extends HttpMcpOptions {
  port?: number;
  /** Interface to listen on. Default `127.0.0.1`. Put your own TLS in front to expose it. */
  hostname?: string;
  /** Path the MCP is served at. Default `/mcp`. */
  path?: string;
}

/** Listen with Bun. `GET /health` is open, `path` is the MCP, anything else is a 404. */
export function serveHttp(options: ServeHttpOptions = {}): {
  port: number;
  stop: () => Promise<void>;
} {
  const { port = 4700, hostname = "127.0.0.1", path = "/mcp", ...mcpOptions } = options;
  const mcp = createHttpMcp(mcpOptions);
  const server = Bun.serve({
    port,
    hostname,
    // run_watch and result_get hold a request open for minutes. Bun's default would cut them off.
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ ok: true });
      if (url.pathname.replace(/\/+$/, "") !== path)
        return new Response("not found", { status: 404 });
      return mcp.fetch(request);
    },
  });
  return {
    port: server.port ?? port,
    stop: async () => {
      await server.stop();
      await mcp.close();
    },
  };
}

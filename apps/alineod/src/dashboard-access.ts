/**
 * Auth + CORS for the routes a browser-based dashboard calls directly.
 *
 * alineod has no auth at all by design (README: "trusted/local caller" — the MCP server, demo
 * scripts). A dashboard reachable from a browser changes that: this is additive, gated entirely
 * behind `ALINEOD_DASHBOARD_TOKEN` so a deployment that only ever runs the MCP server sees no
 * behavior change (no token configured → no auth check, same as today; set the token to require
 * `Authorization: Bearer <token>` on every request). CORS is reflected from an explicit
 * allowlist (`ALINEOD_DASHBOARD_ORIGIN`, comma-separated), never a bare wildcard, since a
 * request can carry the bearer token.
 */
import { Elysia } from "elysia";

const TOKEN = process.env.ALINEOD_DASHBOARD_TOKEN ?? "";
const ALLOWED_ORIGINS = (process.env.ALINEOD_DASHBOARD_ORIGIN ?? "http://localhost:4321")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
    Vary: "Origin",
  };
}

export const dashboardAccess = new Elysia()
  .onRequest(({ request, set }) => {
    const origin = request.headers.get("origin");
    for (const [k, v] of Object.entries(corsHeaders(origin))) set.headers[k] = v;

    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    if (!TOKEN) return; // no token configured — auth check disabled (default, non-dashboard use)
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented !== TOKEN) {
      set.status = 401;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  });

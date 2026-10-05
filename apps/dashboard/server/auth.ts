/**
 * Auth and CORS for every route the browser calls. alineod stays an unauthenticated, trusted
 * local daemon — this server is the only process that faces a browser, so the token lives here.
 *
 * - Every request needs `Authorization: Bearer <DASHBOARD_TOKEN>`. `/health` is exempt.
 * - A browser WebSocket cannot send headers, so it presents a single-use ticket instead:
 *   `POST /auth/ticket` (bearer-authed) returns one, the socket URL carries it as `?ticket=`.
 * - CORS is reflected from an explicit allowlist, never a wildcard, because requests carry a token.
 * - The server refuses to start with no token, unless `DASHBOARD_ALLOW_NO_AUTH=1` on loopback.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { config, isLoopback } from "./config";

const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, number>();

export function assertAuthConfig(cfg: { token: string; allowNoAuth: boolean; host: string }): void {
  if (cfg.token) return;
  if (!cfg.allowNoAuth) {
    throw new Error(
      "DASHBOARD_TOKEN is not set. The dashboard server can run raw shell commands in sandboxes, " +
        "so it will not start without a token. For local development, set DASHBOARD_ALLOW_NO_AUTH=1.",
    );
  }
  if (!isLoopback(cfg.host)) {
    throw new Error(
      `DASHBOARD_ALLOW_NO_AUTH=1 is only allowed on a loopback host, not ${cfg.host}.`,
    );
  }
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time comparison. Hashing first gives both sides the same length. */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export function issueTicket(): string {
  const now = Date.now();
  for (const [t, exp] of tickets) if (exp <= now) tickets.delete(t);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, now + TICKET_TTL_MS);
  return ticket;
}

function consumeTicket(ticket: string | null): boolean {
  if (!ticket) return false;
  const exp = tickets.get(ticket);
  tickets.delete(ticket);
  return exp !== undefined && exp > Date.now();
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !config.origins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
    Vary: "Origin",
  };
}

function authorized(request: Request): boolean {
  if (!config.token) return true; // startup already checked this is the loopback opt-in
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return consumeTicket(new URL(request.url).searchParams.get("ticket"));
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return tokenMatches(presented, config.token);
}

export const dashboardAuth = new Elysia()
  .onRequest(({ request, set }) => {
    for (const [k, v] of Object.entries(corsHeaders(request.headers.get("origin"))))
      set.headers[k] = v;
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (new URL(request.url).pathname === "/health") return;
    if (!authorized(request)) {
      set.status = 401;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  })
  .post("/auth/ticket", () => ({ ticket: issueTicket() }));

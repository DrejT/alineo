/**
 * Hardcoded, non-negotiable resource governance for the public, unauthenticated dashboard.
 * Nothing here is ever accepted as a client-supplied request field — see plans/sandbox-dashboard.md
 * ("Hard limits") for why.
 */

// 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first, and
// OpenSandbox (and its proxied execd endpoints, via eip) only listen on IPv4.
export const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL ?? "http://127.0.0.1:8080";
export const OPENSANDBOX_API_KEY = process.env.OPENSANDBOX_API_KEY ?? "";
export const USE_SERVER_PROXY = true;
export const LEDGER_PATH = process.env.LEDGER_PATH ?? "./data/ledger.db";

export const MAX_SANDBOXES = 3;
export const SANDBOX_IMAGE = "node:22";
export const SANDBOX_RESOURCES = { cpu: "250m", memory: "500Mi" };
/** Safety-net auto-expiry (seconds) in case a sandbox is left open indefinitely. */
export const SANDBOX_TIMEOUT_SECONDS = 60 * 60 * 4;
/** Wall-clock cap on a single `POST /api/sandboxes/:id/exec` command. */
export const EXEC_TIMEOUT_MS = 120_000;

export const MAX_AGENTS = 2;
export const AGENTS_DIR = "./agents";
/** The only spec names `POST /api/agents` will accept — never an arbitrary URL or spec body. */
export const ALLOWED_AGENT_SPECS = ["hello-agent", "python-data"] as const;
export type AllowedAgentSpec = (typeof ALLOWED_AGENT_SPECS)[number];

export const PORT = Number(process.env.PORT ?? 3000);

/**
 * Origins allowed to call this API from a browser. The dashboard frontend and the
 * docs-site playground are each deployed separately (Cloudflare Pages, different
 * origins from this API), so CORS is required — `cors()` reflects the request's
 * `Origin` back only when it appears here. Extra origins (a preview deploy, a
 * different local dev port) can be added via `ALLOWED_ORIGINS` (comma-separated).
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://sandbox.alineo.tech",
  "https://docs.alineo.tech",
  // Local dev. This server usually owns :3000, so a local `next dev` for the docs
  // lands on :3001+; `astro dev` for the dashboard defaults to :4321.
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:4321",
  ...(process.env.ALLOWED_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN.trim()] : []),
];

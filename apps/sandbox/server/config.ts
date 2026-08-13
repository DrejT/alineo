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

export const MAX_AGENTS = 2;
export const AGENTS_DIR = "./agents";
/** The only spec names `POST /api/agents` will accept — never an arbitrary URL or spec body. */
export const ALLOWED_AGENT_SPECS = ["hello-agent", "python-data"] as const;
export type AllowedAgentSpec = (typeof ALLOWED_AGENT_SPECS)[number];

export const PORT = Number(process.env.PORT ?? 3000);

/**
 * The frontend is deployed separately to Cloudflare Pages (a different origin
 * from this API), so CORS is required. Override for local dev against
 * `astro dev` (typically http://localhost:4321).
 */
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://sandbox.alineo.tech";

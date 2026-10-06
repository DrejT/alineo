/**
 * Dashboard server configuration. Every setting is an env var read once at import, with a
 * default that works for local development. A bad value fails at startup, not at first use.
 */
import { z } from "zod";

const port = z.coerce.number().int().positive().max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().min(1);

function read<T>(name: string, schema: z.ZodType<T>, fallback: unknown): T {
  const raw = process.env[name];
  const parsed = schema.safeParse(raw === undefined || raw === "" ? fallback : raw);
  if (!parsed.success) throw new Error(`invalid ${name}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export const config = {
  port: read("DASHBOARD_PORT", port, 4700),
  host: read("DASHBOARD_HOST", nonEmpty, "127.0.0.1"),
  /** Bearer token every request must present. Required unless `allowNoAuth` is set. */
  token: process.env.DASHBOARD_TOKEN ?? "",
  /** Opt-in to run with no token. Only honored when `host` is a loopback address. */
  allowNoAuth: process.env.DASHBOARD_ALLOW_NO_AUTH === "1",
  /** Browser origins allowed to call the API cross-origin (comma-separated). */
  origins: read("DASHBOARD_ORIGINS", nonEmpty, "http://localhost:4321")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  alineodUrl: read("ALINEOD_URL", nonEmpty, "http://127.0.0.1:4600").replace(/\/+$/, ""),
  /** The dashboard's own state: workflow runs, remembered sandbox resources. */
  dbPath: read("DASHBOARD_DB_PATH", nonEmpty, "./data/dashboard.db"),
  /** The substrate ledger for sandboxes this server creates. Never alineod's ledger file. */
  ledgerPath: read("DASHBOARD_LEDGER_PATH", nonEmpty, "./data/dashboard-ledger.db"),
  swarm: {
    plannerModel: read("DASHBOARD_SWARM_PLANNER_MODEL", nonEmpty, "gemini-flash-latest"),
    agentModel: read("DASHBOARD_SWARM_AGENT_MODEL", nonEmpty, "gemini-flash-latest"),
    maxDepth: read("DASHBOARD_SWARM_MAX_DEPTH", positiveInt, 4),
    maxAgents: read("DASHBOARD_SWARM_MAX_AGENTS", positiveInt, 12),
    parentTimeoutMs: read("DASHBOARD_SWARM_PARENT_TIMEOUT_MS", positiveInt, 5 * 60_000),
    retryMs: read("DASHBOARD_SWARM_RETRY_MS", positiveInt, 1_000),
  },
} as const;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

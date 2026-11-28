/**
 * The operator's side: one alineod that keeps two teams apart, and alineo-mcp served over
 * streamable HTTP in front of it. This is the small entry file a deployer writes in their own
 * repo. Everything that is policy (who holds which key, the limit numbers) lives here, not in
 * alineo.
 *
 *   MCP client ── Authorization: Bearer <key> ──▶ alineo-mcp --http (:4700)
 *                                                    │ forwards the same header
 *                                                    ▼
 *                                                 alineod (:4601) ── authenticate(key) → tenant
 *
 * The MCP holds no credential. It passes each caller's header through, and alineod decides who
 * the caller is. Two processes would work the same way; one keeps the recipe to one terminal.
 *
 * Needs the workspace and alineo-mcp built (see README), OpenSandbox running, and NVIDIA_API_KEY in
 * this process's environment.
 */
import { installLoggerFromEnv } from "@alineo-labs/logger";
import { startDaemon } from "../../apps/alineod/src/daemon.ts";
import { Limits } from "../../apps/alineod/src/limits.ts";
import { serveHttp } from "../../packages/mcp/dist/lib.mjs";

// alineod logs to stderr, as it does when it runs alone. ALINEO_LOG_LEVEL adjusts it.
installLoggerFromEnv({ defaultLevel: "info" });

const ALINEOD_PORT = Number(process.env.ALINEOD_PORT ?? 4601);
const MCP_PORT = Number(process.env.MCP_PORT ?? 4700);

// Your key store. Here it is two demo keys from the environment, as `tenant=key,tenant=key`.
// A tenant id may not contain ':' (it separates the tenant from its memory scope).
const KEYS = new Map<string, string>(
  (process.env.TEAM_KEYS ?? "alice=alice-demo-key,bob=bob-demo-key")
    .split(",")
    .map((pair) => pair.split("=") as [string, string])
    .map(([tenant, key]) => [key, tenant]),
);

const daemon = await startDaemon({
  port: ALINEOD_PORT,
  // Map the bearer key to a tenant, or refuse the request with a 401.
  authenticate: (request) => {
    const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const tenantId = key ? KEYS.get(key) : undefined;
    return tenantId ? { tenantId } : null;
  },
  // A spec may read only the model key from this process's environment. Without this, any user
  // could write "${ANY_SECRET}" into a spec and read it inside their sandbox.
  specEnvAllow: ["NVIDIA_API_KEY"],
  // Per-team caps on sandboxes. alineo ships the mechanism; the numbers are yours.
  limits: new Limits({ defaults: { maxOpenRuns: 2, maxLiveAgents: 4 } }),
});

const mcp = serveHttp({ port: MCP_PORT, baseUrl: `http://127.0.0.1:${daemon.port}` });

console.log(
  `alineod on :${daemon.port} (teams: ${[...KEYS.values()].join(", ")}), MCP on http://127.0.0.1:${mcp.port}/mcp`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void mcp.stop();
    daemon.stop();
    process.exit(0);
  });
}

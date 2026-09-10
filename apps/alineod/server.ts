/**
 * alineod — the swarm control daemon. Prototype.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design. This is `prototype/alineod` — off main, no tests yet.
 */
import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { PORT, IDLE_TIMEOUT_SECONDS } from "./config";
import "./src/state/db"; // side effect: open the db, create tables
import { connectSdkAdapter } from "./src/engine/registry";
import { rehydrate } from "./src/engine/rehydrate";
import { toErrorResponse } from "./src/routes/http";
import { runsRoutes } from "./src/routes/runs";
import { agentsRoutes } from "./src/routes/agents";
import { resultsRoutes } from "./src/routes/results";

await connectSdkAdapter();
await rehydrate();

const app = new Elysia({
  // Bun kills idle sockets after ~10s by default — lethal for SSE and the result long-poll.
  serve: { idleTimeout: IDLE_TIMEOUT_SECONDS },
})
  .use(openapi())
  .onError(({ error }) => toErrorResponse(error))
  .get("/health", () => ({ ok: true }))
  .use(runsRoutes)
  .use(agentsRoutes)
  .use(resultsRoutes)
  .listen(PORT);

console.log(`[alineod] listening on http://localhost:${PORT}  (OpenAPI at /openapi)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[alineod] ${sig} — shutting down (agents keep running; state is durable)`);
    app.stop();
    process.exit(0);
  });
}

export type App = typeof app;

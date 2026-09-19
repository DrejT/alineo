/**
 * The alineod HTTP app, without listening or rehydrating — `server.ts` does both. Kept separate
 * so tests can drive every route through `app.handle(request)` with no socket involved.
 */
import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { IDLE_TIMEOUT_SECONDS } from "../config";
import { toErrorResponse } from "./routes/http";
import { runsRoutes } from "./routes/runs";
import { agentsRoutes } from "./routes/agents";
import { resultsRoutes } from "./routes/results";
import { awaitRoutes } from "./routes/await";

export function createApp() {
  return new Elysia({
    // Bun kills idle sockets after ~10s by default — lethal for SSE and the result long-poll.
    serve: { idleTimeout: IDLE_TIMEOUT_SECONDS },
  })
    .use(openapi())
    .onError(({ error, request, code }) => toErrorResponse(error, { request, code }))
    .get("/health", () => ({ ok: true }))
    .use(runsRoutes)
    .use(agentsRoutes)
    .use(resultsRoutes)
    .use(awaitRoutes);
}

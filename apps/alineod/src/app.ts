/**
 * The alineod HTTP app, without listening or rehydrating — `server.ts` does both. Kept separate
 * so tests can drive every route through `app.handle(request)` with no socket involved.
 */
import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { IDLE_TIMEOUT_SECONDS } from "../config";
import { authPlugin, type AccessOptions } from "./auth";
import { accessPlugin } from "./access";
import { toErrorResponse } from "./routes/http";
import { runsRoutes } from "./routes/runs";
import { agentsRoutes } from "./routes/agents";
import { resultsRoutes } from "./routes/results";
import { awaitRoutes } from "./routes/await";
import { memoryRoutes } from "./routes/memory";

/** Unset options (the default) mean no authentication and no restriction, exactly as before. See `src/auth.ts`. */
export type CreateAppOptions = AccessOptions;

export function createApp(options: CreateAppOptions = {}) {
  const app = new Elysia({
    // Bun kills idle sockets after ~10s by default — lethal for SSE and the result long-poll.
    serve: { idleTimeout: IDLE_TIMEOUT_SECONDS },
  });
  // First, so the check runs before routing and covers every route below, plugins included.
  if (options.authenticate || options.specEnvAllow || options.limits?.active) {
    app.use(authPlugin(options));
  }
  // Tenant checks only mean something when there is a caller to check.
  if (options.authenticate) app.use(accessPlugin);
  return app
    .use(openapi())
    .onError(({ error, request, code }) => toErrorResponse(error, { request, code }))
    .get("/health", () => ({ ok: true }))
    .use(runsRoutes)
    .use(agentsRoutes)
    .use(resultsRoutes)
    .use(awaitRoutes)
    .use(memoryRoutes);
}

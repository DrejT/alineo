/**
 * The dashboard HTTP app, without listening — `index.ts` does that. Kept separate so tests can
 * drive every route through `app.handle(request)` with no socket involved.
 */
import { Elysia } from "elysia";
import { dashboardAuth } from "./auth";
import { toErrorResponse } from "./http";
import { alineodRoutes } from "./routes/alineod";
import { sandboxesRoutes } from "./routes/sandboxes";
import { swarmsRoutes } from "./routes/swarms";
import { workflowsRoutes } from "./routes/workflows";
import { settingsRoutes } from "./routes/settings";

/** Bun closes idle sockets after ~10s by default — lethal for the SSE pass-through. 255 is its max. */
const IDLE_TIMEOUT_SECONDS = 255;

export function createApp() {
  return new Elysia({ serve: { idleTimeout: IDLE_TIMEOUT_SECONDS } })
    .onError(({ error, request, code }) => toErrorResponse(error, { request, code }))
    .get("/health", () => ({ ok: true }))
    .use(dashboardAuth)
    .use(alineodRoutes)
    .use(sandboxesRoutes)
    .use(swarmsRoutes)
    .use(workflowsRoutes)
    .use(settingsRoutes);
}

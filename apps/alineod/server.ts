/**
 * alineod — the swarm control daemon.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design.
 */
import { getLogger, installLoggerFromEnv } from "@alineo-labs/logger";
import { PORT, configWarnings } from "./config";
import "./src/state/db"; // side effect: open the db, create tables
import { connectSdkAdapter } from "./src/engine/registry";
import { rehydrate } from "./src/engine/rehydrate";
import { createApp } from "./src/app";

// A daemon logs by default; ALINEO_LOG_LEVEL / ALINEO_LOG / ALINEO_LOG_FORMAT adjust it
// (see @alineo-labs/logger). The libraries it drives stay silent unless told otherwise.
installLoggerFromEnv({ defaultLevel: "info" });
const log = getLogger("alineod");

// ./config is evaluated on import, before the logger exists, so it queues its warnings instead.
for (const warning of configWarnings) log.warn(warning);

await connectSdkAdapter();
await rehydrate();

const app = createApp().listen(PORT);

log.info("listening", { url: `http://localhost:${PORT}`, openapi: "/openapi" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down (agents keep running; state is durable)", { signal: sig });
    app.stop();
    process.exit(0);
  });
}

export type App = typeof app;

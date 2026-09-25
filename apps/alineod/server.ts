/**
 * alineod — the swarm control daemon.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design.
 */
import { getLogger, installLoggerFromEnv } from "@alineo-labs/logger";
import { LEASE_TTL_MS, PORT, configWarnings } from "./config";
import "./src/state/db"; // side effect: open the db, create tables
import { acquireLease, LeaseHeldError } from "./src/state/lease";
import { connectSdkAdapter } from "./src/engine/registry";
import { rehydrate } from "./src/engine/rehydrate";
import { createApp } from "./src/app";

// A daemon logs by default; ALINEO_LOG_LEVEL / ALINEO_LOG / ALINEO_LOG_FORMAT adjust it
// (see @alineo-labs/logger). The libraries it drives stay silent unless told otherwise.
installLoggerFromEnv({ defaultLevel: "info" });
const log = getLogger("alineod");

// ./config is evaluated on import, before the logger exists, so it queues its warnings instead.
for (const warning of configWarnings) log.warn(warning);

// Before rehydrate: rehydrate reattaches every live agent, and a second instance doing the same
// would drive them twice. See src/state/lease.ts.
let lease;
try {
  lease = await acquireLease({
    ttlMs: LEASE_TTL_MS,
    onLost: (holder) => {
      log.error("lease taken over by another instance; exiting so agents aren't driven twice", {
        host: holder?.host,
        pid: holder?.pid,
      });
      process.exit(1);
    },
  });
} catch (err) {
  if (!(err instanceof LeaseHeldError)) throw err;
  log.error(err.message);
  process.exit(1);
}

await connectSdkAdapter();
await rehydrate();

const app = createApp().listen(PORT);

log.info("listening", { url: `http://localhost:${PORT}`, openapi: "/openapi" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down (agents keep running; state is durable)", { signal: sig });
    app.stop();
    lease.release();
    process.exit(0);
  });
}

export type App = typeof app;

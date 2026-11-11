/**
 * alineod — the swarm control daemon.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design.
 */
import { getLogger, installLoggerFromEnv } from "@alineo-labs/logger";
import {
  AUTH_TOKEN,
  LEASE_TTL_MS,
  PORT,
  SPEC_ENV_ALLOW,
  SWEEP_INTERVAL_MS,
  configWarnings,
} from "./config";
import "./src/state/db"; // side effect: open the db, create tables
import { acquireLease, LeaseHeldError } from "./src/state/lease";
import { connectSdkAdapter } from "./src/engine/registry";
import { rehydrate } from "./src/engine/rehydrate";
import { initMemory } from "./src/engine/memory";
import { createApp } from "./src/app";
import { tokenAuthenticate } from "./src/auth";
import { Limits } from "./src/limits";
import { startSweeper } from "./src/engine/sweeper";

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
// Before rehydrate: reconnected agents are handed this store, and a bad path should stop the
// daemon here rather than on the first spawn.
initMemory();
await rehydrate();

const limits = new Limits();
const app = createApp({
  authenticate: AUTH_TOKEN ? tokenAuthenticate(AUTH_TOKEN) : undefined,
  specEnvAllow: SPEC_ENV_ALLOW,
  limits,
}).listen(PORT);

// Only when there is something to sweep: a run-age limit, or a way to suspend a tenant.
const sweeper = limits.needsSweep ? startSweeper(limits, SWEEP_INTERVAL_MS) : undefined;

log.info("listening", {
  url: `http://localhost:${PORT}`,
  openapi: "/openapi",
  auth: AUTH_TOKEN ? "token" : "none",
  specEnv:
    SPEC_ENV_ALLOW === undefined ? "unrestricted" : SPEC_ENV_ALLOW.length ? "allowlist" : "none",
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down (agents keep running; state is durable)", { signal: sig });
    sweeper?.stop();
    app.stop();
    lease.release();
    process.exit(0);
  });
}

export type App = typeof app;

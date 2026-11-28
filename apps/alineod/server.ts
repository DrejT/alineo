/**
 * alineod — the swarm control daemon.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design. The boot sequence itself is `startDaemon()` in
 * src/daemon.ts. This file only reads the options the environment can express and handles signals.
 */
import { getLogger, installLoggerFromEnv } from "@alineo-labs/logger";
import { AUTH_TOKEN, SPEC_ENV_ALLOW } from "./config";
import { tokenAuthenticate } from "./src/auth";
import { startDaemon } from "./src/daemon";

// A daemon logs by default; ALINEO_LOG_LEVEL / ALINEO_LOG / ALINEO_LOG_FORMAT adjust it
// (see @alineo-labs/logger). The libraries it drives stay silent unless told otherwise.
installLoggerFromEnv({ defaultLevel: "info" });
const log = getLogger("alineod");

const daemon = await startDaemon({
  authenticate: AUTH_TOKEN ? tokenAuthenticate(AUTH_TOKEN) : undefined,
  specEnvAllow: SPEC_ENV_ALLOW,
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down (agents keep running; state is durable)", { signal: sig });
    daemon.stop();
    process.exit(0);
  });
}

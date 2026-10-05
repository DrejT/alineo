/** Entry point: `bun server/index.ts`. Checks auth config, connects the ledger, listens. */
import { installLoggerFromEnv, getLogger } from "@alineo-labs/logger";
import { createApp } from "./app";
import { assertAuthConfig } from "./auth";
import { config } from "./config";
import { connectLedger } from "./ledger";

installLoggerFromEnv({ defaultLevel: "info" });
const log = getLogger("dashboard");

try {
  assertAuthConfig(config);
} catch (err) {
  log.error("refusing to start", { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
await connectLedger();

createApp().listen({ port: config.port, hostname: config.host });
log.info("dashboard server listening", {
  url: `http://${config.host}:${config.port}`,
  alineod: config.alineodUrl,
  auth: config.token ? "token" : "disabled (loopback opt-in)",
});

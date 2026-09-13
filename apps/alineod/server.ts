/**
 * alineod — the swarm control daemon.
 *
 *   client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
 *
 * See research/daemon.md for the design.
 */
import { PORT } from "./config";
import "./src/state/db"; // side effect: open the db, create tables
import { connectSdkAdapter } from "./src/engine/registry";
import { rehydrate } from "./src/engine/rehydrate";
import { createApp } from "./src/app";

await connectSdkAdapter();
await rehydrate();

const app = createApp().listen(PORT);

console.log(`[alineod] listening on http://localhost:${PORT}  (OpenAPI at /openapi)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[alineod] ${sig} — shutting down (agents keep running; state is durable)`);
    app.stop();
    process.exit(0);
  });
}

export type App = typeof app;

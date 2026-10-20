import { PORT } from "./config";
import { forwarder } from "./forwarder";
import { postEvent } from "./routes/events";

const server = Bun.serve({
  port: PORT,
  routes: {
    "/health": new Response("ok"),
    "/v1/events": {
      POST: (req: Request, srv) => postEvent(req, forwarder, srv.requestIP(req)?.address),
    },
  },
  fetch: () => Response.json({ error: "not found" }, { status: 404 }),
});

console.log(`[telemetry] listening on http://localhost:${server.port}`);

// `docker compose up -d --build` stops the old container with SIGTERM. Send what is queued first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void forwarder.flush().finally(() => process.exit(0));
  });
}

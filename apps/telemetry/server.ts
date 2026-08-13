import { PORT } from "./config";
import { postEvent } from "./routes/events";

const server = Bun.serve({
  port: PORT,
  routes: {
    "/health": new Response("ok"),
    "/v1/events": {
      POST: (req: Request) => postEvent(req),
    },
  },
  fetch: () => Response.json({ error: "not found" }, { status: 404 }),
});

console.log(`[telemetry] listening on http://localhost:${server.port}`);

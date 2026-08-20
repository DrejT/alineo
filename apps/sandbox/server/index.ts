import * as config from "./config";
import * as registry from "./registry";
import * as sandboxRoutes from "./routes/sandboxes";
import * as agentRoutes from "./routes/agents";
import * as terminal from "./ws/terminal";
import * as metrics from "./ws/metrics";
import * as chat from "./ws/chat";
import { cors } from "./cors";
import type { WSData } from "./ws/types";

// A single bad/racy session (e.g. a WS exec resolving against a sandbox deleted
// mid-connection) must never take down the whole process for every other user.
process.on("uncaughtException", (err) => {
  console.error("[sandbox] uncaught exception", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[sandbox] unhandled rejection", reason);
});

const server = Bun.serve({
  port: config.PORT,
  // Bun's default is 10s. SandboxHandle/agent creation (image pulls, package installs)
  // routinely takes longer, so use Bun's max to avoid killing the connection mid-request.
  idleTimeout: 255,
  routes: {
    "/health": new Response("ok"),
    "/api/sandboxes": cors({
      GET: () => sandboxRoutes.listSandboxes(),
      POST: () => sandboxRoutes.createSandbox(),
    }),
    "/api/sandboxes/:id": cors({
      DELETE: (req: Bun.BunRequest<"/api/sandboxes/:id">) =>
        sandboxRoutes.deleteSandbox(req.params.id),
    }),
    "/api/sandboxes/:id/files": cors({
      GET: (req: Bun.BunRequest<"/api/sandboxes/:id/files">) =>
        sandboxRoutes.listDirectory(
          req.params.id,
          new URL(req.url).searchParams.get("path") ?? "/",
        ),
    }),
    "/api/sandboxes/:id/file": cors({
      GET: (req: Bun.BunRequest<"/api/sandboxes/:id/file">) => {
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing ?path=" }, { status: 400 });
        return sandboxRoutes.readFile(req.params.id, path);
      },
      PUT: async (req: Bun.BunRequest<"/api/sandboxes/:id/file">) => {
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing ?path=" }, { status: 400 });
        const content = await req.text();
        return sandboxRoutes.writeFile(req.params.id, path, content);
      },
    }),
    "/api/sandboxes/:id/metrics": cors({
      GET: (req: Bun.BunRequest<"/api/sandboxes/:id/metrics">) =>
        sandboxRoutes.getMetrics(req.params.id),
    }),
    "/api/sandboxes/:id/checkpoints": cors({
      GET: (req: Bun.BunRequest<"/api/sandboxes/:id/checkpoints">) =>
        sandboxRoutes.listCheckpoints(req.params.id),
    }),
    "/api/sandboxes/:id/checkpoint": cors({
      POST: (req: Bun.BunRequest<"/api/sandboxes/:id/checkpoint">) =>
        sandboxRoutes.createCheckpoint(req.params.id),
    }),
    "/api/sandboxes/:id/preview": cors({
      GET: (req: Bun.BunRequest<"/api/sandboxes/:id/preview">) => {
        const port = Number(new URL(req.url).searchParams.get("port"));
        if (!port) return Response.json({ error: "missing ?port=" }, { status: 400 });
        return sandboxRoutes.getPreview(req.params.id, port);
      },
    }),
    "/api/agents": cors({
      GET: () => agentRoutes.listAgents(),
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as { specName?: string };
        if (!body.specName) return Response.json({ error: "missing specName" }, { status: 400 });
        return agentRoutes.createAgent(body.specName);
      },
    }),
    "/api/agents/:id": cors({
      DELETE: (req: Bun.BunRequest<"/api/agents/:id">) => agentRoutes.deleteAgent(req.params.id),
    }),
    "/api/agents/:id/messages": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/messages">) =>
        agentRoutes.getMessages(req.params.id),
    }),
    "/api/agents/:id/state": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/state">) => agentRoutes.getState(req.params.id),
    }),
    "/api/agents/:id/stats": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/stats">) => agentRoutes.getStats(req.params.id),
    }),
    "/api/agents/:id/models": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/models">) => agentRoutes.getModels(req.params.id),
    }),
    "/api/agents/:id/fork-points": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/fork-points">) =>
        agentRoutes.getForkPoints(req.params.id),
    }),
    "/api/agents/:id/export": cors({
      GET: (req: Bun.BunRequest<"/api/agents/:id/export">) => {
        const path = new URL(req.url).searchParams.get("path");
        if (!path) return Response.json({ error: "missing ?path=" }, { status: 400 });
        return agentRoutes.getExport(req.params.id, path);
      },
    }),
    "/ws/sandboxes/:id/terminal": (req, srv) => terminal.upgradeTerminal(req, srv, req.params.id),
    "/ws/sandboxes/:id/metrics": (req, srv) => metrics.upgradeMetrics(req, srv, req.params.id),
    "/ws/agents/:id/chat": (req, srv) => chat.upgradeChat(req, srv, req.params.id),
    "/ws/agents/:id/shell": (req, srv) => terminal.upgradeAgentShell(req, srv, req.params.id),
  },
  websocket: {
    data: {} as WSData,
    open(ws) {
      if (ws.data.kind === "terminal") void terminal.onOpen(ws);
      else if (ws.data.kind === "metrics") void metrics.onOpen(ws);
    },
    message(ws, message) {
      if (ws.data.kind === "terminal") terminal.onMessage(ws, message);
      else if (ws.data.kind === "chat") chat.onMessage(ws, message);
    },
    close(ws) {
      if (ws.data.kind === "terminal") void terminal.onClose(ws);
      else if (ws.data.kind === "metrics") metrics.onClose(ws);
      else if (ws.data.kind === "chat") chat.onClose(ws);
    },
  },
  fetch: () => Response.json({ error: "not found" }, { status: 404 }),
});

await registry.reconcile();

console.log(`[sandbox] API listening on http://localhost:${server.port}`);

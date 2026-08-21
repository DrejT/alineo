import type { Server, ServerWebSocket } from "bun";
import type { SandboxHandle } from "@alineo-labs/sandbox";
import * as registry from "../registry";
import type { WSData } from "./types";

function resolveSandbox(data: Extract<WSData, { kind: "terminal" }>): SandboxHandle | undefined {
  if (data.source === "sandbox") return registry.sandboxes.get(data.id);
  return registry.agents.get(data.id)?.sandbox;
}

/** Route handler for `/ws/sandboxes/:id/terminal` — call from the routes table. */
export function upgradeTerminal(
  req: Request,
  server: Server<WSData>,
  sandboxId: string,
): Response | undefined {
  if (!registry.sandboxes.has(sandboxId)) {
    return Response.json({ error: `Unknown sandbox ${sandboxId}` }, { status: 404 });
  }
  const ok = server.upgrade(req, {
    data: { kind: "terminal", source: "sandbox", id: sandboxId, handle: null },
  });
  return ok ? undefined : new Response("Upgrade failed", { status: 400 });
}

/** Route handler for `/ws/agents/:id/shell` — bridges to `agent.sandbox`, not the chat/Pi session. */
export function upgradeAgentShell(
  req: Request,
  server: Server<WSData>,
  agentId: string,
): Response | undefined {
  if (!registry.agents.has(agentId)) {
    return Response.json({ error: `Unknown agent ${agentId}` }, { status: 404 });
  }
  const ok = server.upgrade(req, {
    data: { kind: "terminal", source: "agent", id: agentId, handle: null },
  });
  return ok ? undefined : new Response("Upgrade failed", { status: 400 });
}

export async function onOpen(ws: ServerWebSocket<WSData>): Promise<void> {
  if (ws.data.kind !== "terminal") return;
  const sb = resolveSandbox(ws.data);
  if (!sb) {
    ws.close(1011, "sandbox no longer exists");
    return;
  }
  const handle = sb.exec("bash", { interactive: true });
  ws.data.handle = handle;

  (async () => {
    try {
      for await (const chunk of handle.stdout()) {
        ws.send(chunk);
      }
    } catch {
      // session ended with an error — fall through and close below
    }
    ws.close(1000, "shell exited");
  })();
}

export function onMessage(
  ws: ServerWebSocket<WSData>,
  message: string | Buffer<ArrayBuffer>,
): void {
  if (ws.data.kind !== "terminal" || !ws.data.handle) return;
  const text = typeof message === "string" ? message : message.toString("utf-8");
  try {
    const msg = JSON.parse(text) as
      | { type: "input"; data: string }
      | { type: "resize"; cols: number; rows: number }
      | { type: "signal"; name: string };
    if (msg.type === "input") ws.data.handle.write(msg.data);
    else if (msg.type === "resize") ws.data.handle.resize(msg.cols, msg.rows);
    else if (msg.type === "signal") ws.data.handle.signal(msg.name);
  } catch {
    // ignore malformed frames
  }
}

export async function onClose(ws: ServerWebSocket<WSData>): Promise<void> {
  if (ws.data.kind !== "terminal" || !ws.data.handle) return;
  await ws.data.handle.close();
}

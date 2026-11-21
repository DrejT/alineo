/**
 * Live view of an agent's browser. The agent runs Chrome inside its sandbox. agent-browser
 * streams the screen over a WebSocket, but that socket sits behind OpenSandbox's proxy, which
 * needs auth headers a browser tab cannot send. So this server opens the upstream socket with
 * the headers and relays each frame to the viewer. The viewer can only watch: nothing the
 * browser sends is passed on to the agent's browser.
 */
import type { ServerWebSocket } from "bun";
import { enableBrowserStream } from "@alineo-labs/agent-browser";
import { validateSession } from "./auth";
import { getSandbox } from "./sandboxes";
import { getHandle } from "./runtime";

export interface BrowserSocketData { userId: string; sandboxId: string; upstream?: WebSocket; closed?: boolean }

const send = (ws: ServerWebSocket<BrowserSocketData>, msg: Record<string, unknown>) => {
  try { ws.send(JSON.stringify(msg)); } catch { /* the viewer is gone */ }
};

/** Check the request and return the socket data, or an error response. A WebSocket cannot send headers, so the token is in the query. */
export function authorizeBrowser(url: URL, sandboxId: string): BrowserSocketData | Response {
  const user = validateSession(url.searchParams.get("token") ?? "");
  if (!user) return new Response("Unauthorized", { status: 401 });
  const sb = getSandbox(user.id, sandboxId);
  if (!sb) return new Response("Not found", { status: 404 });
  if (!sb.agent) return new Response("This sandbox has no agent, so it has no browser.", { status: 409 });
  if (sb.status !== "running") return new Response(`Sandbox is ${sb.status}.`, { status: 409 });
  return { userId: user.id, sandboxId };
}

export const browserSocket = {
  async open(ws: ServerWebSocket<BrowserSocketData>) {
    const { sandboxId } = ws.data;
    send(ws, { type: "status", text: "Connecting to the agent's browser…" });
    try {
      const sb = await getHandle(sandboxId);
      const info = await enableBrowserStream(sb);
      if (ws.data.closed) return;
      const upstream = new WebSocket(info.url, { headers: info.headers } as never);
      ws.data.upstream = upstream;
      upstream.onopen = () => send(ws, { type: "status", text: "Connected. Waiting for the agent to open a page…" });
      upstream.onmessage = (ev) => { try { ws.send(typeof ev.data === "string" ? ev.data : (ev.data as ArrayBuffer)); } catch { /* the viewer is gone */ } };
      upstream.onerror = () => send(ws, { type: "error", text: "The browser stream failed." });
      upstream.onclose = () => { if (!ws.data.closed) send(ws, { type: "status", text: "The browser stream ended." }); };
    } catch (err) {
      send(ws, { type: "error", text: err instanceof Error ? err.message : String(err) });
    }
  },
  message() { /* view only */ },
  close(ws: ServerWebSocket<BrowserSocketData>) {
    ws.data.closed = true;
    try { ws.data.upstream?.close(); } catch { /* already closed */ }
  },
};

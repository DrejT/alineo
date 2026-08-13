import type { Agent, AgentStream, ThinkingLevel } from "@alineo-labs/agent";
import type { Server, ServerWebSocket } from "bun";
import * as registry from "../registry";
import type { WSData } from "./types";

type ChatCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "followUp"; text: string }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "setSessionName"; name: string }
  | { type: "clone" }
  | { type: "fork"; entryId: string }
  | { type: "switchSession"; path: string }
  | { type: "exportHtml" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "cycleModel" }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "cycleThinkingLevel" }
  | { type: "setAutoCompaction"; enabled: boolean }
  | { type: "compact"; customInstructions?: string }
  | { type: "setAutoRetry"; enabled: boolean }
  | { type: "abortRetry" };

type DataCommand = Exclude<ChatCommand, { type: "prompt" | "steer" | "followUp" | "abort" }>;

/**
 * Dispatch a one-shot agent command that isn't part of the prompt stream. Commands whose
 * `Agent` method returns data are echoed back as `command_result` so the UI can update without
 * a separate fetch; void ones just succeed silently.
 */
async function runCommand(
  ws: ServerWebSocket<WSData>,
  agent: Agent,
  cmd: DataCommand,
): Promise<void> {
  try {
    let result: unknown;
    switch (cmd.type) {
      case "newSession":
        await agent.newSession();
        break;
      case "setSessionName":
        await agent.setSessionName(cmd.name);
        break;
      case "clone":
        result = await agent.clone();
        break;
      case "fork":
        result = await agent.fork(cmd.entryId);
        break;
      case "switchSession":
        result = await agent.switchSession(cmd.path);
        break;
      case "exportHtml":
        result = await agent.exportHtml();
        break;
      case "setModel":
        result = await agent.setModel(cmd.provider, cmd.modelId);
        break;
      case "cycleModel":
        result = await agent.cycleModel();
        break;
      case "setThinkingLevel":
        await agent.setThinkingLevel(cmd.level);
        break;
      case "cycleThinkingLevel":
        result = await agent.cycleThinkingLevel();
        break;
      case "setAutoCompaction":
        await agent.setAutoCompaction(cmd.enabled);
        break;
      case "compact":
        result = await agent.compact(cmd.customInstructions);
        break;
      case "setAutoRetry":
        await agent.setAutoRetry(cmd.enabled);
        break;
      case "abortRetry":
        await agent.abortRetry();
        break;
    }
    ws.send(JSON.stringify({ type: "command_result", command: cmd.type, result: result ?? null }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "bridge_error", message: String(err) }));
  }
}

/** Route handler for `/ws/agents/:id/chat` — call from the routes table. */
export function upgradeChat(
  req: Request,
  server: Server<WSData>,
  agentId: string,
): Response | undefined {
  if (!registry.agents.has(agentId)) {
    return Response.json({ error: `Unknown agent ${agentId}` }, { status: 404 });
  }
  const ok = server.upgrade(req, { data: { kind: "chat", agentId, streaming: false } });
  return ok ? undefined : new Response("Upgrade failed", { status: 400 });
}

async function streamEvents(
  ws: ServerWebSocket<WSData>,
  data: Extract<WSData, { kind: "chat" }>,
  stream: AgentStream,
): Promise<void> {
  data.streaming = true;
  try {
    for await (const event of stream) {
      ws.send(JSON.stringify(event));
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "bridge_error", message: String(err) }));
  } finally {
    data.streaming = false;
  }
}

export function onMessage(
  ws: ServerWebSocket<WSData>,
  message: string | Buffer<ArrayBuffer>,
): void {
  if (ws.data.kind !== "chat") return;
  const data = ws.data;
  const agent = registry.agents.get(data.agentId);
  if (!agent) {
    ws.close(1011, "agent no longer exists");
    return;
  }
  const text = typeof message === "string" ? message : message.toString("utf-8");
  let cmd: ChatCommand;
  try {
    cmd = JSON.parse(text) as ChatCommand;
  } catch {
    return;
  }

  if (cmd.type === "prompt") {
    if (data.streaming) return; // use steer()/followUp() to interject, not a second prompt()
    void streamEvents(ws, data, agent.prompt(cmd.text));
  } else if (cmd.type === "steer") {
    void agent.steer(cmd.text);
  } else if (cmd.type === "followUp") {
    void agent.followUp(cmd.text);
  } else if (cmd.type === "abort") {
    void agent.abort();
  } else {
    void runCommand(ws, agent, cmd);
  }
}

export function onClose(ws: ServerWebSocket<WSData>): void {
  if (ws.data.kind !== "chat" || !ws.data.streaming) return;
  const agent = registry.agents.get(ws.data.agentId);
  void agent?.abort();
}

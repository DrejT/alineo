/**
 * Prompting a sandbox's agent and streaming what it does. The agent is Pi, running inside the
 * sandbox. Every turn is written to the sandbox log and the ledger, like a shell command.
 */
import { db } from "./db";
import { getSandbox } from "./sandboxes";
import { getAgent } from "./runtime";
import { resolveModel, scrub } from "./models";

/** What the browser receives. Tool names and text only: no backend model ids. */
export type AgentFrame =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; tool: string; input: string }
  | { type: "tool_end"; id: string; tool: string; output: string; isError: boolean }
  | { type: "note"; text: string }
  | { type: "done"; ms: number; chars: number }
  | { type: "error"; message: string };

const MAX_TOOL_TEXT = 2000;
const STEER_WAIT_MS = 120_000;

/** Plain text of Pi's last assistant message. */
function lastAssistantText(messages: Array<{ role: string; [k: string]: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("");
    }
  }
  return "";
}

function clip(value: unknown, max = MAX_TOOL_TEXT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function log(userId: string, sandboxId: string, type: string, text: string, ts: number): void {
  const stamp = new Date(ts).toISOString().substring(11, 23);
  db.prepare(`INSERT INTO sandbox_logs (user_id, sandbox_id, type, text, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, sandboxId, type, `[${stamp}] ${text}`, ts);
}

function ledger(userId: string, ts: number, sandboxId: string, tool: string, detail: string, branch: string, label: string, payload: unknown): void {
  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, ts, "exec_event", sandboxId, tool, detail, branch, label, JSON.stringify(payload));
}

/** Send one prompt and yield frames until the turn ends. One turn at a time per agent. */
export async function* promptAgent(userId: string, sandboxId: string, message: string): AsyncGenerator<AgentFrame> {
  const sb = getSandbox(userId, sandboxId);
  if (!sb) { yield { type: "error", message: `Sandbox ${sandboxId} not found` }; return; }
  if (!sb.agent) { yield { type: "error", message: "This sandbox has no agent. Create it with the agent option on." }; return; }
  if (sb.status !== "running") { yield { type: "error", message: `Sandbox is ${sb.status}. Resume it first.` }; return; }

  const model = resolveModel(sb.modelProvider);
  const branch = sb.parentId ? "fork" : "main";
  let entry;
  try {
    entry = await getAgent(sandboxId, model.id, sb.cpuLimitMilli, sb.memLimitMi);
  } catch (err) {
    yield { type: "error", message: scrub(err instanceof Error ? err.message : String(err), model) };
    return;
  }
  if (entry.busy) {
    yield { type: "error", message: "The agent is still working on the last prompt. Steer it, or wait." };
    return;
  }

  // Pi may still be finishing work from an earlier steer or follow-up. Wait for it, so a new
  // prompt does not collide with it.
  entry.busy = true;
  entry.steered = false;
  const settle = Date.now() + 60_000;
  while (Date.now() < settle) {
    const st = await entry.agent.getState().catch(() => null);
    if (!st || !st.isStreaming) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const start = Date.now();
  let chars = 0;
  let reply = "";
  log(userId, sandboxId, "exec_start", `agent_prompt: ${clip(message, 200)}`, start);
  ledger(userId, start, sandboxId, "AGENT_PROMPT", `Prompted agent ${sandboxId}: "${clip(message, 120)}"`, branch, "prompt", { message: clip(message, 500), model: model.id });

  try {
    for await (const ev of entry.agent.prompt(message)) {
      if (ev.type === "text") {
        const text = scrub(ev.text, model);
        chars += text.length;
        reply += text;
        yield { type: "text", text };
      } else if (ev.type === "tool_start") {
        const input = scrub(clip(ev.args), model);
        log(userId, sandboxId, "exec_event", `tool ${ev.toolName}: ${clip(input, 160)}`, Date.now());
        ledger(userId, Date.now(), sandboxId, "AGENT_TOOL", `Agent ran ${ev.toolName}`, branch, `tool ${ev.toolName}`, { tool: ev.toolName, input: clip(input, 500) });
        yield { type: "tool_start", id: ev.toolCallId, tool: ev.toolName, input };
      } else if (ev.type === "tool_end") {
        yield { type: "tool_end", id: ev.toolCallId, tool: ev.toolName, output: scrub(clip(ev.result), model), isError: ev.isError };
      }
    }
    // A steer redirects the agent after this stream closes: Pi carries on with the new instruction.
    // Wait for that work to finish, then show its reply, so the user sees the result of the steer.
    if (entry.steered) {
      yield { type: "note", text: "Steered: the agent is working on your new instruction." };
      const deadline = Date.now() + STEER_WAIT_MS;
      while (Date.now() < deadline) {
        const state = await entry.agent.getState().catch(() => null);
        if (state && !state.isStreaming && state.pendingMessageCount === 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const text = scrub(lastAssistantText(await entry.agent.getMessages().catch(() => [])), model);
      if (text) { chars += text.length; reply += text; yield { type: "text", text }; }
    }
    const ms = Date.now() - start;
    if (chars === 0) {
      // Pi reports a provider failure as an empty turn. Say so instead of showing nothing.
      yield { type: "error", message: "The agent ended the turn without a reply. Try again, or pick another model." };
    } else {
      yield { type: "done", ms, chars };
    }
    log(userId, sandboxId, "exec_complete", `agent_reply (${ms}ms): ${clip(reply, 200)}`, Date.now());
    ledger(userId, Date.now(), sandboxId, "AGENT_REPLY", `Agent replied in ${ms}ms (${chars} chars)`, branch, "reply", { ms, chars, reply: clip(reply, 500) });
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err), model);
    log(userId, sandboxId, "exec_complete", `agent_error: ${clip(msg, 200)}`, Date.now());
    yield { type: "error", message: msg };
  } finally {
    entry.busy = false;
  }
}

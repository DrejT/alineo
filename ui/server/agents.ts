/**
 * Prompting a sandbox's agent and streaming what it does. The agent is Pi, running inside the
 * sandbox. Every turn is written to the sandbox log and the ledger, like a shell command.
 */
import { db } from "./db";
import { getSandbox } from "./sandboxes";
import { getAgent } from "./runtime";
import { resolveModel, scrub } from "./models";
import { log as slog, clipText } from "./log";

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
/** The most an agent may take to finish by itself after its stream ends, and before a new prompt. A hard ceiling only. */
const IDLE_WAIT_MS = 30 * 60_000;
/** An agent that has added no message to its session for this long while it claims to be working is stalled. A long tool call can take minutes. */
const STALL_MS = 5 * 60_000;
/** How often a wait writes a progress line. */
const BEAT_MS = 30_000;

/** Where a wait happened, for the log. */
interface WaitCtx { user: string; sandbox: string; run?: string | null; where: string }

type PiState = { isStreaming: boolean; pendingMessageCount: number; messageCount?: number };

/**
 * Wait until Pi is neither streaming nor holding queued input. It judges the agent by progress, not by elapsed time:
 * an agent whose session keeps gaining messages is working, however long that takes. It gives up (false) only when no
 * message has been added for `stallMs`, or when `maxMs` has passed. Slow, stalled and periodic progress lines are logged.
 */
export async function waitIdle(
  agent: { getState(): Promise<PiState> },
  maxMs: number,
  ctx?: WaitCtx,
  opts: { stallMs?: number; pollMs?: number; beatMs?: number } = {},
): Promise<boolean> {
  const stallMs = opts.stallMs ?? STALL_MS;
  const pollMs = opts.pollMs ?? 1000;
  const beatMs = opts.beatMs ?? BEAT_MS;
  const t0 = Date.now();
  let lastCount: number | undefined;
  let lastProgress = t0;
  let lastBeat = t0;
  let idle = false;
  let why = "limit";
  while (Date.now() - t0 < maxMs) {
    const state = await agent.getState().catch(() => null);
    if (state && !state.isStreaming && state.pendingMessageCount === 0) { idle = true; break; }
    const now = Date.now();
    if (state?.messageCount !== undefined && state.messageCount !== lastCount) { lastCount = state.messageCount; lastProgress = now; }
    if (ctx && now - lastBeat >= beatMs) {
      lastBeat = now;
      slog("info", "wait.progress", { user: ctx.user, sandbox: ctx.sandbox, run: ctx.run, where: ctx.where, waitedMs: now - t0, messageCount: state?.messageCount, isStreaming: state?.isStreaming, msSinceProgress: now - lastProgress }, true);
    }
    if (now - lastProgress >= stallMs) { why = "stalled"; break; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const waited = Date.now() - t0;
  if (ctx && (!idle || waited > 3000)) {
    slog(idle ? "info" : "warn", "wait.idle", { user: ctx.user, sandbox: ctx.sandbox, run: ctx.run, where: ctx.where, idle, waitedMs: waited, limitMs: maxMs, ...(idle ? {} : { why, msSinceProgress: Date.now() - lastProgress, messageCount: lastCount }) }, true);
  }
  return idle;
}

/** The last lines of the bridge's own log inside the sandbox. It records what Pi was told right before it ended a run. */
async function bridgeLog(agent: { getLogs(): Promise<string> }, lines = 25): Promise<string> {
  const text = await agent.getLogs().catch((e) => `(could not read the bridge log: ${e instanceof Error ? e.message : String(e)})`);
  return clipText(String(text).split("\n").filter(Boolean).slice(-lines).join("\n"), 2500);
}

/** What Pi itself says about its last step: the fields that explain why a turn ended. */
async function piSnapshot(agent: { getState(): Promise<unknown>; getMessages(): Promise<Array<{ role: string; [k: string]: unknown }>> }): Promise<Record<string, unknown> & { lastAssistant: { usage?: { totalTokens?: number } } | null; messageCount?: number }> {
  const state = (await agent.getState().catch(() => null)) as Record<string, unknown> | null;
  const messages = await agent.getMessages().catch(() => [] as Array<{ role: string; [k: string]: unknown }>);
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  const parts = Array.isArray(last?.content) ? (last!.content as Array<{ type?: string }>).map((p) => p?.type ?? "?") : typeof last?.content === "string" ? ["text"] : [];
  return {
    isStreaming: state?.isStreaming, pendingMessageCount: state?.pendingMessageCount, messageCount: state?.messageCount,
    lastAssistant: last ? { stopReason: last.stopReason, errorMessage: last.errorMessage ? clipText(last.errorMessage, 400) : undefined, parts, usage: last.usage } : null,
  };
}

/**
 * The text of Pi's last assistant message, but only if that message is a plain reply. A message that also holds a
 * tool call is a step in the work, not an answer, and an empty one is a failed model call.
 */
function finalAssistantText(messages: Array<{ role: string; [k: string]: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    const parts = c as Array<{ type?: string; text?: unknown }>;
    if (parts.some((p) => p && p.type !== "text")) return "";
    return parts.map((p) => String(p.text ?? "")).join("");
  }
  return "";
}

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

/** Save one transcript row, so a chat can be reopened and a background agent can be read later. */
export function recordEvent(userId: string, sandboxId: string, kind: string, text: string, ref?: string): void {
  db.prepare(`INSERT INTO agent_events (user_id, sandbox_id, ts, kind, ref, text) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, sandboxId, Date.now(), kind, ref ?? null, text);
}

export interface TranscriptRow { id: number; ts: number; kind: string; ref: string | null; text: string }

export function transcript(userId: string, sandboxId: string, limit = 400): TranscriptRow[] {
  const rows = db.query(`SELECT id, ts, kind, ref, text FROM agent_events WHERE user_id = ? AND sandbox_id = ? ORDER BY id DESC LIMIT ?`)
    .all(userId, sandboxId, limit) as TranscriptRow[];
  return rows.reverse();
}

function setState(userId: string, sandboxId: string, state: string, result?: string): void {
  if (result === undefined) db.prepare(`UPDATE sandboxes SET state = ? WHERE user_id = ? AND id = ?`).run(state, userId, sandboxId);
  else db.prepare(`UPDATE sandboxes SET state = ?, result = ? WHERE user_id = ? AND id = ?`).run(state, result, userId, sandboxId);
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
export async function* promptAgent(userId: string, sandboxId: string, message: string, opts: { keepWorking?: boolean } = {}): AsyncGenerator<AgentFrame> {
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

  // Pi may still be finishing work from an earlier turn, a steer, or its own retry of a failed model call. A prompt
  // sent now would be refused, so wait for it. If it never goes idle, say so and leave the agent as it is.
  entry.busy = true;
  entry.steered = false;
  const ctx = (where: string): WaitCtx => ({ user: userId, sandbox: sandboxId, run: sb.runId, where });
  let free = await waitIdle(entry.agent, IDLE_WAIT_MS, ctx("before prompt"));
  if (!free) {
    // No new message for five minutes while it claims to be working: most likely a hung model call. Cancel it and take one more look.
    slog("warn", "agent.abort", { user: userId, sandbox: sandboxId, run: sb.runId, reason: "stalled before a new prompt: no new message for five minutes", snapshot: await piSnapshot(entry.agent), bridgeLog: await bridgeLog(entry.agent) }, true);
    await entry.agent.abort().catch(() => {});
    free = await waitIdle(entry.agent, 10_000, ctx("after abort, before prompt"));
  }
  if (!free) {
    slog("error", "turn.refused", { user: userId, sandbox: sandboxId, run: sb.runId, reason: "still busy after abort" }, true);
    entry.busy = false;
    recordEvent(userId, sandboxId, "error", "The agent is still busy with earlier work.");
    yield { type: "error", message: "The agent is still busy with earlier work. Try again in a moment." };
    return;
  }
  recordEvent(userId, sandboxId, "user", message);
  setState(userId, sandboxId, "working");
  let pendingText = "";
  const flushText = () => { if (pendingText) { recordEvent(userId, sandboxId, "agent", pendingText); pendingText = ""; } };
  const start = Date.now();
  let chars = 0;
  let reply = "";
  // Text since the last tool call. This is the agent's answer; text before a tool call is narration.
  let lastSegment = "";
  const seen: Record<string, number> = {};
  let lastEventAt = start;
  let lastBeat = start;
  let toolCalls = 0;
  let longLogged = false;
  const toolStarted = new Map<string, number>();
  const startState = (await entry.agent.getState().catch(() => null)) as { messageCount?: number } | null;
  slog("info", "turn.start", { user: userId, sandbox: sandboxId, run: sb.runId, role: sb.role, model: model.id, backend: model.backend, promptChars: message.length, prompt: clipText(message, 160), sessionMessages: startState?.messageCount }, true);
  log(userId, sandboxId, "exec_start", `agent_prompt: ${clip(message, 200)}`, start);
  ledger(userId, start, sandboxId, "AGENT_PROMPT", `Prompted agent ${sandboxId}: "${clip(message, 120)}"`, branch, "prompt", { message: clip(message, 500), model: model.id });

  try {
    for await (const ev of entry.agent.prompt(message)) {
      seen[ev.type] = (seen[ev.type] ?? 0) + 1;
      lastEventAt = Date.now();
      // A long turn writes one progress line a minute, so a quiet log means a quiet agent.
      if (lastEventAt - lastBeat >= 60_000) {
        lastBeat = lastEventAt;
        slog("info", "turn.progress", { user: userId, sandbox: sandboxId, run: sb.runId, ms: lastEventAt - start, tools: toolCalls, chars, events: seen }, true);
      }
      if (ev.type === "auto_retry_start") {
        slog("warn", "pi.retry", { user: userId, sandbox: sandboxId, run: sb.runId, phase: "start", attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, error: clipText(ev.errorMessage, 400) }, true);
      } else if (ev.type === "auto_retry_end") {
        slog(ev.success ? "info" : "warn", "pi.retry", { user: userId, sandbox: sandboxId, run: sb.runId, phase: "end", attempt: ev.attempt, success: ev.success, error: ev.finalError ? clipText(ev.finalError, 400) : undefined }, true);
      } else if (ev.type === "compaction_start" || ev.type === "compaction_end") {
        slog("info", "pi.compaction", { user: userId, sandbox: sandboxId, run: sb.runId, event: ev.type, reason: ev.reason, ...(ev.type === "compaction_end" ? { aborted: ev.aborted, willRetry: ev.willRetry } : {}) }, true);
      } else if (ev.type === "extension_error") {
        slog("warn", "pi.extension_error", { user: userId, sandbox: sandboxId, run: sb.runId, extension: ev.extensionPath, event: ev.event, error: clipText(ev.error, 400) }, true);
      } else if (ev.type === "agent_end") {
        slog("debug", "pi.agent_end", { user: userId, sandbox: sandboxId, run: sb.runId });
      } else if (ev.type === "text") {
        const text = scrub(ev.text, model);
        chars += text.length;
        reply += text;
        lastSegment += text;
        pendingText += text;
        yield { type: "text", text };
      } else if (ev.type === "tool_start") {
        toolCalls++;
        toolStarted.set(ev.toolCallId, Date.now());
        slog("debug", "tool.start", { user: userId, sandbox: sandboxId, run: sb.runId, tool: ev.toolName });
        if (toolCalls === 100 && !longLogged) {
          longLogged = true;
          slog("warn", "turn.long", { user: userId, sandbox: sandboxId, run: sb.runId, ms: Date.now() - start, tools: toolCalls, note: "100 tool calls in one turn. The goal may be too large, or the agent is looping.", snapshot: await piSnapshot(entry.agent) }, true);
        }
        const input = scrub(clip(ev.args), model);
        log(userId, sandboxId, "exec_event", `tool ${ev.toolName}: ${clip(input, 160)}`, Date.now());
        ledger(userId, Date.now(), sandboxId, "AGENT_TOOL", `Agent ran ${ev.toolName}`, branch, `tool ${ev.toolName}`, { tool: ev.toolName, input: clip(input, 500) });
        flushText();
        lastSegment = "";
        recordEvent(userId, sandboxId, "tool", JSON.stringify({ tool: ev.toolName, input }), ev.toolCallId);
        yield { type: "tool_start", id: ev.toolCallId, tool: ev.toolName, input };
      } else if (ev.type === "tool_end") {
        const output = scrub(clip(ev.result), model);
        const began = toolStarted.get(ev.toolCallId);
        toolStarted.delete(ev.toolCallId);
        if (began && Date.now() - began > 30_000) slog("warn", "tool.slow", { user: userId, sandbox: sandboxId, run: sb.runId, tool: ev.toolName, ms: Date.now() - began }, true);
        if (ev.isError) slog("warn", "tool.error", { user: userId, sandbox: sandboxId, run: sb.runId, tool: ev.toolName, output: clipText(output, 300) }, true);
        const row = db.query(`SELECT id, text FROM agent_events WHERE sandbox_id = ? AND kind = 'tool' AND ref = ? ORDER BY id DESC LIMIT 1`).get(sandboxId, ev.toolCallId) as { id: number; text: string } | null;
        if (row) db.prepare(`UPDATE agent_events SET text = ? WHERE id = ?`).run(JSON.stringify({ ...JSON.parse(row.text), output, isError: ev.isError }), row.id);
        yield { type: "tool_end", id: ev.toolCallId, tool: ev.toolName, output, isError: ev.isError };
      }
    }
    // A steer redirects the agent after this stream closes: Pi carries on with the new instruction.
    // Wait for that work to finish, then show its reply, so the user sees the result of the steer.
    if (entry.steered) {
      flushText();
      recordEvent(userId, sandboxId, "note", "Steered: the agent is working on your new instruction.");
      yield { type: "note", text: "Steered: the agent is working on your new instruction." };
      await waitIdle(entry.agent, STEER_WAIT_MS, ctx("after steer"));
      const text = scrub(lastAssistantText(await entry.agent.getMessages().catch(() => [])), model);
      if (text) { chars += text.length; reply += text; lastSegment += text; yield { type: "text", text }; }
    }
    flushText();
    // What the stream looked like when it ended. This is the line to read first when a turn stops early.
    const streamMs = Date.now() - start;
    slog("info", "stream.end", {
      user: userId, sandbox: sandboxId, run: sb.runId, ms: streamMs, events: seen, tools: toolCalls, chars,
      lastSegmentChars: lastSegment.trim().length, msSinceLastEvent: Date.now() - lastEventAt, steered: entry.steered,
    }, true);
    // The stream can end while the agent is still working: Pi retries a failed model call by itself, and a dropped
    // connection ends the stream but not the agent. Wait for it to finish, then take its answer from its own session.
    if (lastSegment.trim().length === 0) {
      slog("warn", "turn.cut_short", { user: userId, sandbox: sandboxId, run: sb.runId, snapshot: await piSnapshot(entry.agent), bridgeLog: await bridgeLog(entry.agent) }, true);
      const idle = await waitIdle(entry.agent, IDLE_WAIT_MS, ctx("after stream ended without a reply"));
      if (!idle) {
        // Stalled: cancel it, so the nudge that follows can restart the work.
        slog("warn", "agent.abort", { user: userId, sandbox: sandboxId, run: sb.runId, reason: "stalled: no new message for five minutes after its stream ended", snapshot: await piSnapshot(entry.agent), bridgeLog: await bridgeLog(entry.agent) }, true);
        await entry.agent.abort().catch(() => {});
      }
      const snap = await piSnapshot(entry.agent);
      const text = scrub(finalAssistantText(await entry.agent.getMessages().catch(() => [])), model).trim();
      slog(text ? "info" : "warn", "turn.recovery", { user: userId, sandbox: sandboxId, run: sb.runId, idle, recoveredChars: text.length, snapshot: snap }, true);
      if (text) {
        chars += text.length; reply += text; lastSegment += text;
        recordEvent(userId, sandboxId, "agent", text);
        yield { type: "text", text };
      }
    }
    const ms = Date.now() - start;
    // A turn is finished only if the agent wrote text after its last tool call. A turn that ends right after
    // a tool result, or after narration such as "Let me check...", was cut short (a model error, a rate limit,
    // a dropped connection). Calling it done would hand the user a half-finished run.
    if (lastSegment.trim().length === 0) {
      const none = chars === 0;
      const note = none ? "The agent ended the turn without a reply." : "The agent stopped before giving a final reply.";
      recordEvent(userId, sandboxId, "error", note);
      // A caller that will retry keeps the agent marked as working, so nobody sees a false failure.
      if (!opts.keepWorking) setState(userId, sandboxId, "failed", none ? "" : clip(reply, 4000));
      const endSnap = await piSnapshot(entry.agent);
      slog("warn", "turn.end", { user: userId, sandbox: sandboxId, run: sb.runId, outcome: "unfinished", willRetry: Boolean(opts.keepWorking), ms, chars, tools: toolCalls, sessionMessages: endSnap.messageCount, contextTokens: endSnap.lastAssistant?.usage?.totalTokens }, true);
      yield { type: "error", message: `${note} Try again, or pick another model.` };
    } else {
      setState(userId, sandboxId, "done", clip(lastSegment.trim(), 4000));
      const endSnap = await piSnapshot(entry.agent);
      slog("info", "turn.end", { user: userId, sandbox: sandboxId, run: sb.runId, outcome: "done", ms, chars, tools: toolCalls, sessionMessages: endSnap.messageCount, contextTokens: endSnap.lastAssistant?.usage?.totalTokens }, true);
      yield { type: "done", ms, chars };
    }
    log(userId, sandboxId, "exec_complete", `agent_reply (${ms}ms): ${clip(reply, 200)}`, Date.now());
    ledger(userId, Date.now(), sandboxId, "AGENT_REPLY", `Agent replied in ${ms}ms (${chars} chars)`, branch, "reply", { ms, chars, reply: clip(reply, 500) });
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err), model);
    slog("error", "turn.error", { user: userId, sandbox: sandboxId, run: sb.runId, ms: Date.now() - start, events: seen, tools: toolCalls, error: clipText(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 500) }, true);
    flushText();
    recordEvent(userId, sandboxId, "error", msg);
    setState(userId, sandboxId, "failed", "");
    log(userId, sandboxId, "exec_complete", `agent_error: ${clip(msg, 200)}`, Date.now());
    yield { type: "error", message: msg };
  } finally {
    entry.busy = false;
  }
}

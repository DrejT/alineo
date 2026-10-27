/**
 * Builds the judge's TRACE (what the agent actually ran) from alineod's run event stream. The
 * `/agents/:id/transcript` endpoint came back empty for finished Pi agents, but the SSE stream replays every
 * tool start (`toolName`, `args`) and tool end (`result`, `isError`) from the beginning of the run.
 */
import { ALINEOD } from "./alineod.ts";

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse a Server-Sent-Events body into events, ignoring comments, pings and malformed JSON. */
export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      out.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
    } catch {
      // partial block at the end of a read
    }
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "..." : s).replace(/\s+/g, " ").trim();

/**
 * Arguments of a tool call. A written file's content is kept (up to 2,500 characters) because the judge needs
 * it to check claims about the code ("handles errors gracefully"); v3 found clipping it to 260 characters made
 * true claims about a script look unsupported. Everything else stays short.
 */
export function renderArgs(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const content = typeof a["content"] === "string" ? (a["content"] as string) : undefined;
  if (content !== undefined) {
    const { content: _c, ...rest } = a;
    const body = content.length > 2500 ? content.slice(0, 2500) + "\n...(content truncated)" : content;
    return `${clip(JSON.stringify(rest), 200)} content<<<\n${body}\n>>>`;
  }
  const edits = a["edits"];
  if (Array.isArray(edits)) {
    const text = JSON.stringify(edits);
    return `${clip(JSON.stringify({ ...a, edits: undefined }), 120)} edits=${text.length > 2500 ? text.slice(0, 2500) + "...(truncated)" : text}`;
  }
  return clip(JSON.stringify(a), 320);
}

/** One line per tool call and per tool result for one agent: what ran, not what was said about it. */
export function traceFromEvents(events: SseEvent[], agentId: string): string {
  const lines: string[] = [];
  for (const { data } of events) {
    if (data["agentId"] !== agentId || typeof data["toolName"] !== "string") continue;
    const name = data["toolName"] as string;
    if ("args" in data && !("result" in data)) {
      lines.push(`CALL ${name} ${renderArgs(data["args"])}`);
    } else if ("result" in data) {
      const res = data["result"] as { content?: { text?: string }[]; structuredContent?: { output?: string; exit_code?: number } } | undefined;
      const sc = res?.structuredContent;
      const text = sc?.output ?? res?.content?.map((c) => c.text ?? "").join("") ?? "";
      const exit = typeof sc?.exit_code === "number" ? ` exit=${sc.exit_code}` : "";
      lines.push(`RESULT ${name}${data["isError"] === true ? " (error)" : ""}${exit}: ${clip(text, 200)}`);
    }
  }
  const out = lines.join("\n");
  return out.length > 9000 ? out.slice(0, 9000) + "\n...(truncated)" : out || "(no tool calls recorded)";
}

export interface Usage {
  input: number;
  output: number;
  total: number;
  /** Provider-reported cost in USD when the harness supplies it, else 0. */
  cost: number;
}

/**
 * Token usage for one agent, summed over its assistant messages. The same message is streamed several times
 * (start / update / end), so each is counted once by its timestamp + usage fingerprint.
 */
export function usageFromEvents(events: SseEvent[], agentId: string): Usage {
  const seen = new Set<string>();
  const u: Usage = { input: 0, output: 0, total: 0, cost: 0 };
  for (const { data } of events) {
    if (data["agentId"] !== agentId) continue;
    const m = data["message"] as { role?: string; timestamp?: unknown; usage?: Record<string, unknown> } | undefined;
    if (!m || m.role !== "assistant" || !m.usage) continue;
    const key = `${String(m.timestamp ?? "")}|${JSON.stringify(m.usage)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = num(m.usage["input"]);
    const output = num(m.usage["output"]);
    u.input += input;
    u.output += output;
    u.total += num(m.usage["totalTokens"]) || input + output;
    u.cost += num((m.usage["cost"] as { total?: unknown } | undefined)?.total);
  }
  return u;
}

/** Trace plus token usage in one pass over the event stream. Never throws. */
export async function fetchRunEvidence(
  runId: string,
  agentId: string,
): Promise<{ trace: string; usage: Usage }> {
  const events = await readEvents(runId);
  return { trace: traceFromEvents(events, agentId), usage: usageFromEvents(events, agentId) };
}

export async function readEvents(runId: string, idleMs = 2500, maxMs = 15_000): Promise<SseEvent[]> {
  const ctl = new AbortController();
  const hard = setTimeout(() => ctl.abort(), maxMs);
  let text = "";
  try {
    const res = await fetch(`${ALINEOD}/runs/${runId}/events`, { signal: ctl.signal });
    if (!res.ok || !res.body) return [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), idleMs)),
      ]);
      if (next.done) break;
      text += dec.decode(next.value, { stream: true });
    }
    ctl.abort();
  } catch {
    // aborted by the hard timeout; use what arrived
  } finally {
    clearTimeout(hard);
  }
  return parseSse(text);
}

/** Read the run's SSE replay until it goes quiet, then build the trace. Never throws. */
export async function fetchTrace(runId: string, agentId: string, idleMs = 2500, maxMs = 15_000): Promise<string> {
  const ctl = new AbortController();
  const hard = setTimeout(() => ctl.abort(), maxMs);
  let text = "";
  try {
    const res = await fetch(`${ALINEOD}/runs/${runId}/events`, { signal: ctl.signal });
    if (!res.ok || !res.body) return `(events unavailable: HTTP ${res.status})`;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), idleMs)),
      ]);
      if (next.done) break;
      text += dec.decode(next.value, { stream: true });
    }
    ctl.abort();
  } catch {
    // aborted by the hard timeout; use what arrived
  } finally {
    clearTimeout(hard);
  }
  return traceFromEvents(parseSse(text), agentId);
}

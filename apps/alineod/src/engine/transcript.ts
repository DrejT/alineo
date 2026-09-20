/**
 * What an agent said and did, read back from the ledger. The harness ends each turn with an
 * `agent_end` event carrying that turn's full messages; alineod persists it as-is, so the whole
 * conversation — prompts, replies, tool calls, tool output, the model API's errors — is already
 * there. This flattens Pi's message blocks into something a person can read.
 */
import { readAgentEvents } from "../state/db";

/** Longer text (usually tool output) is cut to this many characters unless `full` is set. */
const SHORT_TEXT_CHARS = 2_000;

export type TranscriptMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: { name: string; arguments: unknown }[];
      stopReason: string | null;
      errorMessage: string | null;
      thinking?: string;
    }
  | { role: "tool"; toolName: string; text: string; isError: boolean };

export interface TranscriptTurn {
  seq: number;
  ts: number;
  messages: TranscriptMessage[];
}

interface Block {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content)
    ? (content as Block[]).filter((b) => b && typeof b === "object")
    : [];
}

function joinText(content: unknown, type: "text" | "thinking"): string {
  return blocks(content)
    .filter((b) => b.type === type)
    .map((b) => (typeof b[type] === "string" ? (b[type] as string) : ""))
    .join("\n");
}

function shorten(text: string, full: boolean): string {
  if (full || text.length <= SHORT_TEXT_CHARS) return text;
  return `${text.slice(0, SHORT_TEXT_CHARS)}… [${text.length - SHORT_TEXT_CHARS} more characters; use ?full=1]`;
}

function toMessage(raw: unknown, full: boolean): TranscriptMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.role) {
    case "user":
      return { role: "user", text: shorten(joinText(m.content, "text"), full) };
    case "assistant": {
      const out: TranscriptMessage = {
        role: "assistant",
        text: shorten(joinText(m.content, "text"), full),
        toolCalls: blocks(m.content)
          .filter((b) => b.type === "toolCall")
          .map((b) => ({
            name: typeof b.name === "string" ? b.name : "?",
            arguments: b.arguments,
          })),
        stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
        errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
      };
      if (full) {
        const thinking = joinText(m.content, "thinking");
        if (thinking) out.thinking = thinking;
      }
      return out;
    }
    case "toolResult":
      return {
        role: "tool",
        toolName: typeof m.toolName === "string" ? m.toolName : "?",
        text: shorten(joinText(m.content, "text"), full),
        isError: m.isError === true,
      };
    default:
      return undefined; // a role we don't know: leave it out rather than guess
  }
}

export function buildTranscript(
  agentId: string,
  opts: { full?: boolean } = {},
): { agentId: string; turns: TranscriptTurn[] } {
  const full = opts.full === true;
  const turns: TranscriptTurn[] = [];
  for (const row of readAgentEvents(agentId, "agent_end")) {
    let messages: unknown;
    try {
      messages = (JSON.parse(row.payload ?? "{}") as { messages?: unknown }).messages;
    } catch {
      continue; // a damaged row shouldn't hide the turns around it
    }
    if (!Array.isArray(messages)) continue;
    turns.push({
      seq: row.seq,
      ts: row.ts,
      messages: messages.flatMap((m) => toMessage(m, full) ?? []),
    });
  }
  return { agentId, turns };
}

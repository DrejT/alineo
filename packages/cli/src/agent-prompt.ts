import type { Agent } from "@alineo-labs/agent";

export interface CollectedReply {
  /** Concatenated `text` deltas. Empty if the run produced tool activity but no final prose --
   * that's a real, valid outcome (see `toolCalls`), not evidence the stream was truncated. */
  text: string;
  /** Every tool call seen during the stream, in order -- present even when `text` is empty, so
   * a caller can tell "genuinely did nothing" apart from "did things, said nothing" instead of
   * both collapsing into the same empty string. */
  toolCalls: { name: string; isError: boolean }[];
}

/** Sends one prompt and collects the text chunks plus a record of any tool calls made. */
export async function collectReply(
  agent: Agent,
  message: string,
  opts?: { inactivityTimeoutMs?: number },
): Promise<CollectedReply> {
  let text = "";
  const toolCalls: CollectedReply["toolCalls"] = [];
  for await (const ev of agent.prompt(message, opts)) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "tool_end") toolCalls.push({ name: ev.toolName, isError: ev.isError });
  }
  return { text, toolCalls };
}

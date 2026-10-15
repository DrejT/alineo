import type { AgentEvent } from "../types";
import type { HarnessEvent } from "./events";

/** The text of an error-ish `unknown`. */
function messageOf(e: unknown): string {
  return typeof e === "string" ? e : "";
}

/** A message's id, when Pi gives one. Pi's message shape is open, so check before use. */
function messageIdOf(message: unknown): string | null {
  if (message && typeof message === "object" && "id" in message) {
    const id = message.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Map one event of Pi's bridge stream to harness events. Zero, one or more come back.
 *
 * Every returned event carries the Pi event as `raw`. Nothing is dropped except one
 * thing: a `text_delta` inside `message_update`. The bridge sends the same text again as
 * its own `text` event, and mapping both would show the text twice.
 *
 * `agent_end` becomes `done`. The bridge ends a turn with `agent_end`. The error path
 * (a bridge `{error}` frame, a timeout, an abort) is not an event on this stream. The
 * adapter that reads the stream must emit `done` with `reason: "error"` or `"aborted"`.
 */
export function fromPiEvent(ev: AgentEvent): HarnessEvent[] {
  const raw: unknown = ev;
  switch (ev.type) {
    case "agent_start":
      return [{ type: "run_start", raw }];
    case "agent_end":
      return [{ type: "done", reason: "completed", raw }];
    case "text":
      return [{ type: "text", text: ev.text, raw }];
    case "turn_start":
      return [{ type: "turn_start", turnIndex: ev.turnIndex, raw }];
    case "turn_end":
      return [{ type: "turn_end", turnIndex: ev.turnIndex, raw }];
    case "message_start":
      return [{ type: "message_start", messageId: messageIdOf(ev.message), raw }];
    case "message_end":
      return [{ type: "message_end", messageId: messageIdOf(ev.message), raw }];
    case "message_update": {
      const delta = ev.delta;
      if (delta && typeof delta === "object" && "type" in delta) {
        const d = delta as { type: unknown; delta?: unknown };
        if (d.type === "thinking_delta" && typeof d.delta === "string") {
          return [{ type: "reasoning", text: d.delta, raw }];
        }
      }
      return [];
    }
    case "tool_start":
      return [
        {
          type: "tool_start",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
          raw,
        },
      ];
    case "tool_update":
      return [
        {
          type: "tool_update",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          partial: ev.partialResult,
          raw,
        },
      ];
    case "tool_end":
      return [
        {
          type: "tool_end",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          result: ev.result,
          isError: ev.isError,
          raw,
        },
      ];
    case "permission_request":
      return [
        {
          type: "permission_request",
          requestId: ev.requestId,
          tool: ev.tool,
          target: ev.target,
          title: ev.title,
          raw,
        },
      ];
    case "permission_resolved":
      return [{ type: "permission_resolved", requestId: ev.requestId, decision: ev.decision, raw }];
    case "compaction_start":
      return [{ type: "compaction", phase: "start", reason: ev.reason, raw }];
    case "compaction_end":
      return [
        {
          type: "compaction",
          phase: "end",
          reason: ev.reason,
          aborted: ev.aborted,
          willRetry: ev.willRetry,
          raw,
        },
      ];
    case "auto_retry_start":
      return [
        {
          type: "retry",
          phase: "start",
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          error: messageOf(ev.errorMessage),
          raw,
        },
      ];
    case "auto_retry_end":
      return [
        {
          type: "retry",
          phase: "end",
          attempt: ev.attempt,
          success: ev.success,
          error: messageOf(ev.finalError),
          raw,
        },
      ];
    case "queue_update":
      return [{ type: "queue", steering: ev.steering, followUp: ev.followUp, raw }];
    case "extension_ui":
      return [{ type: "vendor", harness: "pi", name: "extension_ui", data: ev, raw }];
    case "extension_error":
      return [{ type: "vendor", harness: "pi", name: "extension_error", data: ev, raw }];
  }
}

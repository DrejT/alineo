import type { AgentEvent } from "../types";
import type { HarnessAdapter, TurnInput } from "./adapter";
import type { HarnessEvent } from "./events";

/**
 * Project a harness event onto the public `AgentEvent` that `prompt()` has always yielded.
 * `null` means the event has no `AgentEvent` form.
 *
 * Pi's events pass through unchanged: `fromPiEvent` keeps each one as `raw`, so the
 * projection is the identity and no Pi caller sees a difference. Every other harness is
 * projected from the neutral fields. This is a bridge for compatibility. It is removed
 * when `AgentEvent` is retired in favor of `HarnessEvent`.
 */
export function toAgentEvent(ev: HarnessEvent, harnessId: string): AgentEvent | null {
  if (harnessId === "pi" && ev.raw !== undefined) return ev.raw as AgentEvent;
  switch (ev.type) {
    case "run_start":
      return { type: "agent_start" };
    case "done":
      // Only a completed turn has an `agent_end`. An aborted or failed one has none.
      return ev.reason === "completed" ? { type: "agent_end", messages: [] } : null;
    case "text":
      return { type: "text", text: ev.text };
    case "reasoning":
      return null;
    case "turn_start":
      return { type: "turn_start", turnIndex: ev.turnIndex, timestamp: Date.now() };
    case "turn_end":
      return { type: "turn_end", turnIndex: ev.turnIndex, message: null, toolResults: [] };
    case "message_start":
      return { type: "message_start", message: { role: "assistant", id: ev.messageId } };
    case "message_end":
      return { type: "message_end", message: { role: "assistant", id: ev.messageId } };
    case "tool_start":
      return {
        type: "tool_start",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
      };
    case "tool_update":
      return {
        type: "tool_update",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        partialResult: ev.partial,
      };
    case "tool_end":
      return {
        type: "tool_end",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        result: ev.result,
        isError: ev.isError,
      };
    case "permission_request":
      return {
        type: "permission_request",
        requestId: ev.requestId,
        tool: ev.tool,
        target: ev.target,
        title: ev.title,
      };
    case "permission_resolved":
      return { type: "permission_resolved", requestId: ev.requestId, decision: ev.decision };
    case "compaction":
      return ev.phase === "start"
        ? { type: "compaction_start", reason: asCompactionReason(ev.reason) }
        : {
            type: "compaction_end",
            reason: asCompactionReason(ev.reason),
            result: null,
            aborted: ev.aborted ?? false,
            willRetry: ev.willRetry ?? false,
          };
    case "retry":
      return ev.phase === "start"
        ? {
            type: "auto_retry_start",
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts ?? ev.attempt,
            delayMs: ev.delayMs ?? 0,
            errorMessage: ev.error ?? "",
          }
        : {
            type: "auto_retry_end",
            success: ev.success ?? false,
            attempt: ev.attempt,
            finalError: ev.error,
          };
    case "queue":
      return { type: "queue_update", steering: ev.steering, followUp: ev.followUp };
    case "vendor":
    case "error":
      return null;
  }
}

function asCompactionReason(reason: string): "manual" | "threshold" | "overflow" {
  return reason === "threshold" || reason === "overflow" ? reason : "manual";
}

/**
 * Run a turn and yield `AgentEvent`s, as `prompt()` always has. A failed turn throws the
 * original error, so callers that catch `PromptTimeoutError` or `BridgeDisconnectedError`
 * keep working. A failure with no error object throws a plain `Error` with its message.
 */
export async function* legacyStream(
  adapter: HarnessAdapter,
  input: TurnInput,
): AsyncGenerator<AgentEvent> {
  for await (const h of adapter.runTurn(input)) {
    if (h.type === "error") throw h.raw instanceof Error ? h.raw : new Error(h.message);
    const ev = toAgentEvent(h, adapter.id);
    if (ev) yield ev;
  }
}

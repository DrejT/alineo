import type { PermissionDecision } from "../types";

/**
 * What a harness turn yields, whichever harness runs it (Pi, Claude Code, Codex).
 *
 * The set is small on purpose. An event every harness can produce has its own `type`. A
 * thing only one harness has goes in `vendor`, so a new harness never widens this union.
 * Anything a harness reports that this union cannot hold stays in `raw`.
 *
 * Contract: a turn ends with exactly one `done`, including after an abort.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export type HarnessEvent = HarnessEventBody & {
  /** The harness's own event this one came from, untouched. For debugging and `vendor` use. */
  raw?: unknown;
};

export type HarnessEventBody =
  /** The run began. Pi: `agent_start`. */
  | { type: "run_start" }
  /** A chunk of assistant prose. */
  | { type: "text"; text: string }
  /** A chunk of the model's reasoning, for harnesses that expose it. */
  | { type: "reasoning"; text: string }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number }
  /**
   * An assistant message began. `messageId` is the id to hand back when forking at this
   * message. It is `null` when the harness gives none. A caller must never invent one.
   */
  | { type: "message_start"; messageId: string | null }
  | { type: "message_end"; messageId: string | null }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partial: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "permission_request"; requestId: string; tool: string; target: string; title: string }
  | { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
  | {
      type: "compaction";
      phase: "start" | "end";
      reason: string;
      /** Only on `end`. */
      aborted?: boolean;
      /** Only on `end`. */
      willRetry?: boolean;
    }
  | {
      type: "retry";
      phase: "start" | "end";
      attempt: number;
      /** Only on `start`. */
      maxAttempts?: number;
      /** Only on `start`. */
      delayMs?: number;
      /** Only on `end`. */
      success?: boolean;
      /** The error that caused the retry (`start`) or ended it (`end`). */
      error?: string;
    }
  /** The steering and follow-up queues changed. */
  | { type: "queue"; steering: string[]; followUp: string[] }
  /** Something only this harness has. Callers who do not know `harness` ignore it. */
  | { type: "vendor"; harness: string; name: string; data: unknown }
  /** The harness failed. A `done` with `reason: "error"` follows. */
  | { type: "error"; message: string }
  /** The one terminal event of a turn. */
  | { type: "done"; reason: "completed" | "aborted" | "error" };

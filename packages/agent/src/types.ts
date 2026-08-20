/**
 * A single event emitted by an agent stream. Discriminated on `type`.
 *
 * - `text` — a chunk of Pi's text response (assistant prose)
 * - `tool_start` — Pi started executing a tool (bash, file write, etc.)
 * - `tool_update` — streaming progress from an in-flight tool execution
 * - `tool_end` — a tool finished; `result` holds its output, `isError` whether it failed
 * - `extension_ui` — a Pi extension requested UI interaction; dialog requests are
 *   auto-cancelled by the bridge so Pi never stalls, but the event is forwarded so
 *   callers can observe what was requested
 * - `auto_retry_start` — Pi is about to retry after a transient error (429, 5xx)
 * - `auto_retry_end` — Pi's retry sequence completed (success or exhausted)
 * - `agent_start` — Pi began processing the prompt
 * - `agent_end` — Pi finished the full agent run (all turns complete)
 * - `turn_start` — a new LLM turn began
 * - `turn_end` — a turn completed with its assistant message and tool results
 * - `message_start` — a new assistant message began streaming
 * - `message_update` — streaming delta from an in-flight message; `delta` is the raw
 *   Pi assistantMessageEvent (text_delta, thinking_delta, tool_call_delta, etc.)
 * - `message_end` — an assistant message completed
 * - `queue_update` — the steering/follow-up queue changed (e.g. after `followUp()`)
 * - `compaction_start` — Pi began compacting context (manual or auto)
 * - `compaction_end` — context compaction finished
 * - `extension_error` — a Pi extension threw an error
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | {
      type: "extension_ui";
      method: string;
      params: unknown;
      isDialog: boolean;
      requestId?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }
  | { type: "turn_start"; turnIndex: number; timestamp: number }
  | { type: "turn_end"; turnIndex: number; message: unknown; toolResults: unknown[] }
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown; delta: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        estimatedTokensAfter: number;
        details: unknown;
      } | null;
      aborted: boolean;
      willRetry: boolean;
    }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

/**
 * Async iterable of structured agent events. Returned by `Alineo.prompt()` and `Alineo.bash()`.
 *
 * Use `textOnly()` to filter down to just the text chunks:
 *
 * ```ts
 * for await (const chunk of textOnly(agent.prompt("Hello"))) {
 *   process.stdout.write(chunk);
 * }
 * ```
 *
 * Or iterate the full stream to observe tool calls:
 *
 * ```ts
 * for await (const ev of agent.prompt("Build a widget")) {
 *   if (ev.type === "text") process.stdout.write(ev.text);
 *   else if (ev.type === "tool_start") console.log("Pi is running:", ev.toolName, ev.args);
 *   else if (ev.type === "tool_end") console.log("Tool done, isError:", ev.isError);
 * }
 * ```
 */
export type AgentStream = AsyncIterable<AgentEvent>;

/** Filter an `AgentStream` down to just text chunks. */
export async function* textOnly(stream: AgentStream): AsyncIterable<string> {
  for await (const ev of stream) {
    if (ev.type === "text") yield ev.text;
  }
}

/**
 * @deprecated Use `AgentStream`. `PromptStream` will be removed in a future minor.
 */
export type PromptStream = AsyncIterable<string>;

/**
 * A Pi model as returned by `getAvailableModels`, `setModel`, and (nested in
 * `{ model, thinkingLevel, isScoped } | null`) `cycleModel`.
 */
export interface PiModel {
  id: string;
  api: string;
  [key: string]: unknown;
}

/** Thinking (reasoning) level supported by models that have extended thinking. */
export type ThinkingLevel = "none" | "low" | "medium" | "high";

/** A single message in Pi's conversation history, as returned by `getMessages`. */
export interface PiMessage {
  role: "user" | "assistant";
  [key: string]: unknown;
}

/** Result of a `compact` operation. */
export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

/** Session statistics returned by `agent.getSessionStats()`. */
export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number;
    contextWindow: number;
    percent: number;
  };
}

/** A Pi slash command as returned by `agent.getCommands()`. */
export interface PiSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: unknown;
}

/** Pi's current session state, as returned by `agent.getState()`. */
export interface PiSessionState {
  model?: PiModel;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

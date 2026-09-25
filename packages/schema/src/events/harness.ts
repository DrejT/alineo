/**
 * The harness stream — what the agent-loop driver reports while a turn runs.
 *
 * These are the highest-volume events in the system and most of them are stream-only: a
 * `message.updated` delta is superseded by the `message.ended` that follows it, so persisting
 * every one would bloat the ledger to record something the next event already says.
 *
 * Two collisions the subject namespacing settles: `agent_start`/`agent_end` were a *harness
 * session* beginning and ending, not an alineod agent's lifecycle, so they become
 * `session.*`; and `text` was a delta of exactly one message, so it becomes
 * `message.updated` rather than keeping a name that hides what it is about.
 */
import { z } from "zod";
import { defineEvent } from "../define";

export const SessionStarted = defineEvent({
  type: "session.started",
  durable: true,
  version: 1,
  description: "The harness began a session. Was `agent_start`.",
  schema: z.object({}),
});

export const SessionEnded = defineEvent({
  type: "session.ended",
  durable: true,
  version: 1,
  description: "The harness session finished. Was `agent_end`.",
  schema: z.object({ messages: z.array(z.unknown()).optional() }),
});

export const TurnStarted = defineEvent({
  type: "turn.started",
  durable: true,
  version: 1,
  schema: z.object({ turnIndex: z.number().int(), timestamp: z.number() }),
});

export const TurnEnded = defineEvent({
  type: "turn.ended",
  durable: true,
  version: 1,
  schema: z.object({
    turnIndex: z.number().int(),
    message: z.unknown().optional(),
    toolResults: z.array(z.unknown()).optional(),
  }),
});

export const ToolStarted = defineEvent({
  type: "tool.started",
  durable: true,
  version: 1,
  schema: z.object({ toolCallId: z.string(), toolName: z.string(), args: z.unknown() }),
});

export const ToolUpdated = defineEvent({
  type: "tool.updated",
  durable: false,
  version: 1,
  description: "A partial tool result. Superseded by `tool.ended`.",
  schema: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    partialResult: z.unknown(),
  }),
});

export const ToolEnded = defineEvent({
  type: "tool.ended",
  durable: true,
  version: 1,
  schema: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    isError: z.boolean(),
  }),
});

export const MessageStarted = defineEvent({
  type: "message.started",
  // Stream-only, matching what alineod persists today. A turn's final message is already
  // recorded by `turn.ended`, which is what `GET /agents/:id/transcript` is built from — so
  // persisting the message boundaries as well would store the same text a second time.
  durable: false,
  version: 1,
  schema: z.object({ message: z.unknown() }),
});

export const MessageUpdated = defineEvent({
  type: "message.updated",
  durable: false,
  version: 1,
  description:
    "A delta on the message being written — including a plain text chunk, which was its own " +
    "`text` event before. Superseded by `message.ended`.",
  schema: z.object({
    message: z.unknown().optional(),
    delta: z.unknown().optional(),
    /** Set when the delta is plain text and nothing else. */
    text: z.string().optional(),
  }),
});

export const MessageEnded = defineEvent({
  type: "message.ended",
  durable: false,
  version: 1,
  schema: z.object({ message: z.unknown() }),
});

export const CompactionStarted = defineEvent({
  type: "compaction.started",
  durable: true,
  version: 1,
  schema: z.object({ reason: z.enum(["manual", "threshold", "overflow"]) }),
});

export const CompactionEnded = defineEvent({
  type: "compaction.ended",
  durable: true,
  version: 1,
  schema: z.object({
    reason: z.enum(["manual", "threshold", "overflow"]),
    result: z
      .object({
        summary: z.string(),
        firstKeptEntryId: z.string(),
        tokensBefore: z.number(),
        estimatedTokensAfter: z.number(),
        details: z.unknown(),
      })
      .nullable(),
    aborted: z.boolean(),
    willRetry: z.boolean(),
  }),
});

export const RetryStarted = defineEvent({
  type: "retry.started",
  durable: true,
  version: 1,
  description: "The harness is retrying a failed model call. Was `auto_retry_start`.",
  schema: z.object({
    attempt: z.number().int(),
    maxAttempts: z.number().int(),
    delayMs: z.number(),
    errorMessage: z.string(),
  }),
});

export const RetryEnded = defineEvent({
  type: "retry.ended",
  durable: true,
  version: 1,
  schema: z.object({
    success: z.boolean(),
    attempt: z.number().int(),
    finalError: z.string().optional(),
  }),
});

export const QueueUpdated = defineEvent({
  type: "queue.updated",
  durable: false,
  version: 1,
  description: "The steering and follow-up queues changed. A view of current state, not a fact.",
  schema: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }),
});

export const ExtensionUi = defineEvent({
  type: "extension.ui",
  durable: false,
  version: 1,
  description: "An extension asked the host to show something.",
  schema: z.object({
    method: z.string(),
    params: z.unknown(),
    isDialog: z.boolean(),
    requestId: z.string().optional(),
  }),
});

export const ExtensionError = defineEvent({
  type: "extension.error",
  durable: true,
  version: 1,
  schema: z.object({ extensionPath: z.string(), event: z.string(), error: z.string() }),
});

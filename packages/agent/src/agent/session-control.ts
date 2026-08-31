import type { AgentStream, PermissionDecision } from "../types";
import type { AgentInternal } from "./internal";

/** Send a prompt to Pi and stream the response. Pi manages its own session context. */
export function prompt(
  a: AgentInternal,
  message: string,
  opts?: { streamingBehavior?: "steer" | "followUp"; inactivityTimeoutMs?: number },
): AgentStream {
  return a.adapter.prompt(message, opts);
}

/**
 * Run a shell command inside Pi's working context. Not incrementally
 * streamed — Pi returns bash output synchronously, so the full output
 * arrives as a single `text` event once the command completes.
 */
export function bash(a: AgentInternal, command: string): AgentStream {
  return a.adapter.bash(command);
}

/** Steer Pi's current response mid-flight. Waits for Pi's RPC acknowledgment. */
export async function steer(a: AgentInternal, message: string): Promise<void> {
  return a.adapter.steer(message);
}

/** Abort Pi's current operation. */
export async function abort(a: AgentInternal): Promise<void> {
  return a.adapter.abort();
}

/**
 * Resolve a pending `permission_request` emitted by the permission gate. `decision` is
 * `{ kind: "once" }`, `{ kind: "always" }`, or `{ kind: "reject", feedback? }`.
 */
export async function resolvePermission(
  a: AgentInternal,
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  return a.adapter.resolvePermission(requestId, decision);
}

/** Queue a message to be sent to Pi after it finishes its current task. */
export async function followUp(a: AgentInternal, message: string): Promise<void> {
  return a.adapter.followUp(message);
}

/** Start a fresh Pi session, clearing all prior context. */
export async function newSession(a: AgentInternal): Promise<void> {
  return a.adapter.newSession();
}

/** Enable or disable Pi's automatic context compaction. */
export async function setAutoCompaction(a: AgentInternal, enabled: boolean): Promise<void> {
  return a.adapter.setAutoCompaction(enabled);
}

/**
 * Enable or disable Pi's automatic retry on transient errors (429, 500, 502, 503, 504).
 * Auto-retry is ON by default: 3 attempts with exponential backoff (2 s / 4 s / 8 s).
 * Disable it when you want to handle errors yourself via `auto_retry_start`/`auto_retry_end`
 * events in the stream.
 */
export async function setAutoRetry(a: AgentInternal, enabled: boolean): Promise<void> {
  return a.adapter.setAutoRetry(enabled);
}

/**
 * Abort an in-progress auto-retry immediately. Pi stops waiting and fails the current
 * operation, emitting `auto_retry_end` with `success: false`.
 */
export async function abortRetry(a: AgentInternal): Promise<void> {
  return a.adapter.abortRetry();
}

/** Abort a currently-executing bash command without cancelling the whole prompt. */
export async function abortBash(a: AgentInternal): Promise<void> {
  return a.adapter.abortBash();
}

/**
 * Control how Pi processes queued steering messages.
 * `"all"` applies all queued steers at once; `"one-at-a-time"` applies them sequentially.
 */
export async function setSteeringMode(
  a: AgentInternal,
  mode: "all" | "one-at-a-time",
): Promise<void> {
  return a.adapter.setSteeringMode(mode);
}

/**
 * Control how Pi processes queued follow-up messages.
 * `"all"` sends all queued follow-ups at once; `"one-at-a-time"` sends them sequentially.
 */
export async function setFollowUpMode(
  a: AgentInternal,
  mode: "all" | "one-at-a-time",
): Promise<void> {
  return a.adapter.setFollowUpMode(mode);
}

/** Set a display name for the current Pi session. */
export async function setSessionName(a: AgentInternal, name: string): Promise<void> {
  return a.adapter.setSessionName(name);
}

import { LedgerEvent } from "@alineo-labs/core";
import type {
  AgentStream,
  PendingPermission,
  PermissionDecision,
  PermissionRequest,
} from "../types";
import type { AgentInternal } from "./internal";

/**
 * Called for each `permission_request` on a `prompt()`/`bash()` stream when passed as
 * `opts.onPermission`. Return the decision; the SDK resolves the request for you. The
 * `permission_request` / `permission_resolved` events still flow through the stream.
 */
export type PermissionHandler = (
  req: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

/**
 * Wrap a raw adapter stream so that every permission event is mirrored to the ledger
 * (`PermissionRequested` / `PermissionResolved`) and, when `onPermission` is given, each
 * request is auto-resolved with the handler's decision.
 */
async function* instrument(
  a: AgentInternal,
  stream: AgentStream,
  onPermission?: PermissionHandler,
): AgentStream {
  try {
    for await (const ev of stream) {
      if (ev.type === "permission_request") {
        void a.sandbox.emit(LedgerEvent.PermissionRequested, -1, {
          requestId: ev.requestId,
          tool: ev.tool,
          target: ev.target,
        });
        if (onPermission) {
          const req: PermissionRequest = {
            requestId: ev.requestId,
            tool: ev.tool,
            target: ev.target,
            title: ev.title,
          };
          void Promise.resolve(onPermission(req))
            .then((decision) => a.adapter.resolvePermission(ev.requestId, decision))
            .catch(() => {});
        }
      } else if (ev.type === "permission_resolved") {
        void a.sandbox.emit(LedgerEvent.PermissionResolved, -1, {
          requestId: ev.requestId,
          decision: ev.decision,
        });
      }
      yield ev;
    }
  } finally {
    // Turn done (or the consumer broke out / threw) — revert any `allow-once` egress grant
    // made during it, so a one-shot grant never silently becomes permanent.
    await a.egressGate?.endTurn().catch(() => {});
  }
}

/** Send a prompt to Pi and stream the response. Pi manages its own session context. */
export function prompt(
  a: AgentInternal,
  message: string,
  opts?: {
    streamingBehavior?: "steer" | "followUp";
    inactivityTimeoutMs?: number;
    /** Auto-resolve each `permission_request` with this handler's decision. */
    onPermission?: PermissionHandler;
  },
): AgentStream {
  return instrument(a, a.adapter.prompt(message, opts), opts?.onPermission);
}

/**
 * Run a shell command inside Pi's working context. Not incrementally
 * streamed — Pi returns bash output synchronously, so the full output
 * arrives as a single `text` event once the command completes.
 */
export function bash(a: AgentInternal, command: string): AgentStream {
  return instrument(a, a.adapter.bash(command));
}

/** Snapshot of tool calls currently paused awaiting a human decision. */
export async function listPendingPermissions(a: AgentInternal): Promise<PendingPermission[]> {
  return a.adapter.listPendingPermissions();
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

/**
 * Failure policy (agent-supervision.md): what happens when a turn concludes in failure — a
 * model/tool failure (an upstream API error ending the turn) or alineod restarting mid-turn,
 * unified under one `AgentSpec.onFailure` field rather than two separate half-answers to the
 * same question (see the plan for why).
 *
 * Called by driveTurn/catchUpTurn (stream.ts) in place of their own unconditional
 * `handle.settled` + `agent.ended` emission on failure. Returns a decision rather than acting on
 * it directly (e.g. re-invoking `driveTurn` itself) specifically to avoid a circular import:
 * stream.ts owns `driveTurn`, so the caller re-invokes it, not this module.
 */
import { errorCodeFromText } from "@alineo-labs/errors";
import type { ErrorCode } from "@alineo-labs/errors";
import { getAgentRow, type AgentRow } from "../state/projection";
import { recordConsecutiveFailure, recordTurnRetry, resetFailureCounters } from "../state/db";
import {
  TRANSIENT_RETRY_BASE_MS,
  TRANSIENT_RETRY_MAX,
  TRANSIENT_RETRY_MAX_DELAY_MS,
} from "../../config";
import { emit } from "./emit";

export type SupervisionReason = "ask" | "retries-exhausted" | "circuit-tripped";

export type FailureResolution =
  | { action: "settled" }
  /** `delayMs` is how long to wait before re-sending. Absent or 0 means at once. */
  | { action: "retry"; message: string; delayMs?: number }
  | { action: "blocked"; reason: SupervisionReason };

interface FailurePolicySpec {
  onFailure?: "ask" | "retry" | "fail";
  maxRetries?: number;
  maxConsecutiveFailures?: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Decide what happens to a turn that just failed, and emit whatever that decision requires
 * (`agent.turn_failed` always; `handle.settled`/`agent.ended` for `"fail"`; `agent.state_changed` +
 * `agent.supervision_needed` + a best-effort parent notice for a hold). The caller still owns
 * re-invoking `driveTurn` for a `"retry"` decision — this function only decides and records.
 *
 * `retryMessage`: what an automatic retry would re-send, if the caller has one in scope
 * (`driveTurn`'s own prompt) or can reconstruct one (`catchUpTurn` falling back to the agent's
 * stored spawn prompt). `null` when there's genuinely nothing to retry with — a `"retry"` policy
 * with no retry message downgrades to an `"ask"` hold rather than silently doing nothing.
 */
export function resolveTurnFailure(
  runId: string,
  agentId: string,
  opts: {
    error: string;
    /** A code the caller already has, from a thrown error. Else it is classified from `error`. */
    errorCode?: ErrorCode;
    resultRef: string | null;
    retryMessage: string | null;
  },
): FailureResolution {
  const row = getAgentRow(agentId);
  if (!row) return { action: "settled" }; // agent gone — nothing left to decide for

  const errorCode = opts.errorCode ?? errorCodeFromText(opts.error);

  // A transient model-provider failure (429, 5xx) is retried here, before the agent's own
  // onFailure policy sees it. It is not the agent's fault and not a sign the agent is stuck, so
  // it does not count toward the circuit breaker. Bounded, with a growing backoff, so a
  // provider that stays down still ends in the normal policy.
  const transient = nextTransientRetry(agentId, errorCode, opts.retryMessage);
  if (transient) {
    emit(runId, agentId, "agent.turn_retried", {
      error: opts.error,
      errorCode: transient.errorCode,
      attempt: transient.attempt,
      maxAttempts: TRANSIENT_RETRY_MAX,
      delayMs: transient.delayMs,
    });
    return { action: "retry", message: transient.message, delayMs: transient.delayMs };
  }

  const consecutiveFailures = recordConsecutiveFailure(agentId);
  const code = errorCode ? { errorCode } : {};
  emit(runId, agentId, "agent.turn_failed", { error: opts.error, ...code, consecutiveFailures });

  const spec = JSON.parse(row.spec_json) as FailurePolicySpec;
  const maxConsecutiveFailures = spec.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  // Default "fail", not "ask": every existing agent spec in the fleet predates this field and
  // expects a failed turn to settle immediately. Defaulting to a hold would silently change that
  // for every caller who never opted in — confirmed empirically (13 pre-existing tests expect
  // an immediate settle on failure, and none of them set onFailure). Supervision is opt-in.
  const onFailure = spec.onFailure ?? "fail";

  // The circuit breaker overrides onFailure entirely, regardless of remaining retry budget —
  // it doesn't care how the failures are being triggered, only that they keep happening.
  if (consecutiveFailures >= maxConsecutiveFailures) {
    block(runId, row, "circuit-tripped", opts.error, errorCode);
    return { action: "blocked", reason: "circuit-tripped" };
  }

  if (onFailure === "fail") {
    emit(runId, agentId, "handle.settled", { outcome: "failed", resultRef: opts.resultRef });
    emit(runId, agentId, "agent.ended", {
      outcome: "failed",
      endedAt: Date.now(),
      error: opts.error,
      ...code,
    });
    return { action: "settled" };
  }

  if (onFailure === "retry") {
    if (spec.maxRetries === undefined || !opts.retryMessage) {
      // Misconfigured (retry declared with no budget) or nothing to retry with — the safe
      // fallback is a hold an operator can resolve, not a silent no-op or an unbounded loop.
      block(runId, row, "ask", opts.error, errorCode);
      return { action: "blocked", reason: "ask" };
    }
    const turnRetryCount = recordTurnRetry(agentId);
    if (turnRetryCount <= spec.maxRetries) {
      return { action: "retry", message: opts.retryMessage };
    }
    block(runId, row, "retries-exhausted", opts.error, errorCode);
    return { action: "blocked", reason: "retries-exhausted" };
  }

  // onFailure === "ask" (the default) — no auto-retry, hold immediately.
  block(runId, row, "ask", opts.error, errorCode);
  return { action: "blocked", reason: "ask" };
}

/** Per-agent count of transient retries since the last good turn. Memory only, and that is fine:
 * a crash loses the count, and the next failure starts a fresh bounded sequence. */
const transientAttempts = new Map<string, number>();

/** The codes a turn may be retried for. Both are a provider saying "not now". */
const TURN_RETRYABLE: ReadonlySet<ErrorCode> = new Set(["MODEL_RATE_LIMITED", "MODEL_UNAVAILABLE"]);

function nextTransientRetry(
  agentId: string,
  errorCode: ErrorCode | undefined,
  retryMessage: string | null,
): { errorCode: ErrorCode; message: string; attempt: number; delayMs: number } | undefined {
  if (!errorCode || !TURN_RETRYABLE.has(errorCode) || !retryMessage) return undefined;
  if (TRANSIENT_RETRY_MAX <= 0) return undefined;
  const attempt = (transientAttempts.get(agentId) ?? 0) + 1;
  if (attempt > TRANSIENT_RETRY_MAX) return undefined;
  transientAttempts.set(agentId, attempt);
  return { errorCode, message: retryMessage, attempt, delayMs: transientDelayMs(attempt) };
}

/** Backoff for the n-th transient retry: base doubled each time, capped, with up to 25% jitter. */
export function transientDelayMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_RETRY_MAX_DELAY_MS, TRANSIENT_RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(raw * (0.75 + random() * 0.5));
}

/** A turn succeeded: clear the supervision counters and the transient-retry count. */
export function recordTurnSuccess(agentId: string): void {
  resetFailureCounters(agentId);
  transientAttempts.delete(agentId);
}

function block(
  runId: string,
  row: AgentRow,
  reason: SupervisionReason,
  error: string,
  errorCode?: ErrorCode,
): void {
  emit(runId, row.agent_id, "agent.state_changed", { from: row.state, to: "blocked", reason });
  emit(runId, row.agent_id, "agent.supervision_needed", {
    reason,
    error,
    ...(errorCode ? { errorCode } : {}),
  });
}

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
import { getAgentRow, type AgentRow } from "../state/projection";
import { recordConsecutiveFailure, recordTurnRetry } from "../state/db";
import { emit } from "./emit";

export type SupervisionReason = "ask" | "retries-exhausted" | "circuit-tripped";

export type FailureResolution =
  | { action: "settled" }
  | { action: "retry"; message: string }
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
  opts: { error: string; resultRef: string | null; retryMessage: string | null },
): FailureResolution {
  const row = getAgentRow(agentId);
  if (!row) return { action: "settled" }; // agent gone — nothing left to decide for

  const consecutiveFailures = recordConsecutiveFailure(agentId);
  emit(runId, agentId, "agent.turn_failed", { error: opts.error, consecutiveFailures });

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
    block(runId, row, "circuit-tripped", opts.error);
    return { action: "blocked", reason: "circuit-tripped" };
  }

  if (onFailure === "fail") {
    emit(runId, agentId, "handle.settled", { outcome: "failed", resultRef: opts.resultRef });
    emit(runId, agentId, "agent.ended", {
      outcome: "failed",
      endedAt: Date.now(),
      error: opts.error,
    });
    return { action: "settled" };
  }

  if (onFailure === "retry") {
    if (spec.maxRetries === undefined || !opts.retryMessage) {
      // Misconfigured (retry declared with no budget) or nothing to retry with — the safe
      // fallback is a hold an operator can resolve, not a silent no-op or an unbounded loop.
      block(runId, row, "ask", opts.error);
      return { action: "blocked", reason: "ask" };
    }
    const turnRetryCount = recordTurnRetry(agentId);
    if (turnRetryCount <= spec.maxRetries) {
      return { action: "retry", message: opts.retryMessage };
    }
    block(runId, row, "retries-exhausted", opts.error);
    return { action: "blocked", reason: "retries-exhausted" };
  }

  // onFailure === "ask" (the default) — no auto-retry, hold immediately.
  block(runId, row, "ask", opts.error);
  return { action: "blocked", reason: "ask" };
}

function block(runId: string, row: AgentRow, reason: SupervisionReason, error: string): void {
  emit(runId, row.agent_id, "agent.state_changed", { from: row.state, to: "blocked", reason });
  emit(runId, row.agent_id, "agent.supervision_needed", { reason, error });
}

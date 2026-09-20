/**
 * Waiting on other agents' handles (research/swarm-coordination.md §3, research/tier-1-2-plan.md
 * #3). A wait names a set of agents and a regime:
 *
 *   settled — every dependency terminal, any outcome (the original `waitFor: [...]` behaviour)
 *   all     — every dependency succeeded; a failure resolves per `onDepFailure`
 *   any     — the first dependency to settle
 *   quorum  — `k` successes; fails once `k` successes become impossible
 *
 * plus an optional absolute deadline: `onDeadline: "proceed"` resolves with whatever has settled
 * (`partial`), `"fail"` resolves as `deadline`. The deadline is absolute (stored in the ledger), so
 * a wait retried after a restart keeps its original countdown.
 *
 * The wait graph is a DAG by construction — every wait is declared at spawn time against agents
 * that already exist — so no deadlock detection is needed.
 */
import { onRun } from "../bus";
import { getAgentRow, getHandle } from "../state/projection";
import { emit } from "./emit";

export type WaitMode = "settled" | "all" | "any" | "quorum";

export interface NormalizedWait {
  agents: string[];
  mode: WaitMode;
  k?: number;
  onDepFailure: "fail" | "proceed";
  onDeadline: "proceed" | "fail";
  /** Absolute epoch ms. */
  deadlineAt?: number;
}

export interface WaitOutcome {
  outcome: "satisfied" | "partial" | "deadline" | "depfail";
  /** The dependencies whose results count — what a spawned child gets as inputs. */
  selected: string[];
  settled: { agentId: string; outcome: string | null }[];
  pending: string[];
  failed: string[];
}

export type WaitForInput =
  | string[]
  | {
      agents: string[];
      mode?: WaitMode;
      k?: number;
      onDepFailure?: "fail" | "proceed";
      deadlineSec?: number;
      onDeadline?: "proceed" | "fail";
    };

/** The request form → the stored form (absolute deadline). `null` when there's nothing to wait on. */
export function normalizeWait(
  input: WaitForInput | undefined | null,
  now = Date.now(),
): NormalizedWait | null {
  if (!input) return null;
  if (Array.isArray(input)) {
    return input.length > 0
      ? { agents: input, mode: "settled", onDepFailure: "fail", onDeadline: "proceed" }
      : null;
  }
  if (input.agents.length === 0) return null;
  return {
    agents: input.agents,
    mode: input.mode ?? "settled",
    ...(input.k !== undefined ? { k: input.k } : {}),
    onDepFailure: input.onDepFailure ?? "fail",
    onDeadline: input.onDeadline ?? "proceed",
    ...(input.deadlineSec !== undefined ? { deadlineAt: now + input.deadlineSec * 1000 } : {}),
  };
}

/** The stored form, as persisted in `agent_spawned` — accepts the old plain-array rows too. */
export function parseStoredWait(json: string | null): NormalizedWait | null {
  if (!json) return null;
  const v = JSON.parse(json) as unknown;
  if (Array.isArray(v)) return normalizeWait(v as string[]);
  return v as NormalizedWait;
}

/** A human-readable problem with a wait spec, or null when it's valid. */
export function validateWait(w: NormalizedWait): string | null {
  if (w.mode === "quorum") {
    const k = w.k ?? w.agents.length;
    if (!Number.isInteger(k) || k < 1 || k > w.agents.length) {
      return `quorum k must be an integer between 1 and ${w.agents.length} (got ${w.k})`;
    }
  }
  if (new Set(w.agents).size !== w.agents.length) return "waitFor names the same agent twice";
  return null;
}

/** Which dependencies have settled (earliest first), which are pending, which failed. */
function snapshot(agents: string[]): Omit<WaitOutcome, "outcome" | "selected"> {
  const rows = agents.map((agentId) => ({ agentId, h: getHandle(agentId) }));
  const settled = rows
    .filter((r) => r.h?.state === "settled")
    .sort((a, b) => (a.h?.settled_at ?? 0) - (b.h?.settled_at ?? 0));
  return {
    settled: settled.map((r) => ({ agentId: r.agentId, outcome: r.h?.outcome ?? null })),
    pending: rows.filter((r) => r.h?.state !== "settled").map((r) => r.agentId),
    failed: settled.filter((r) => r.h?.outcome !== "success").map((r) => r.agentId),
  };
}

/**
 * Evaluate a wait against the current handles. Returns the outcome once the regime is decided,
 * or null while it's still waiting. Pure apart from reading the projection.
 */
export function evaluateWait(w: NormalizedWait): WaitOutcome | null {
  const snap = snapshot(w.agents);
  const successes = snap.settled.filter((s) => s.outcome === "success").map((s) => s.agentId);
  const done = (outcome: WaitOutcome["outcome"], selected: string[]): WaitOutcome => ({
    outcome,
    selected,
    ...snap,
  });

  switch (w.mode) {
    case "settled":
      return snap.pending.length === 0 ? done("satisfied", w.agents) : null;
    case "all":
      if (snap.failed.length > 0 && w.onDepFailure === "fail") return done("depfail", []);
      return snap.pending.length === 0 ? done("satisfied", w.agents) : null;
    case "any":
      return snap.settled.length > 0 ? done("satisfied", [snap.settled[0]!.agentId]) : null;
    case "quorum": {
      const k = w.k ?? w.agents.length;
      if (successes.length >= k) return done("satisfied", successes.slice(0, k));
      if (successes.length + snap.pending.length < k) {
        return w.onDepFailure === "fail" ? done("depfail", []) : done("partial", successes);
      }
      return null;
    }
  }
}

/** What a deadline resolves to: whatever has settled so far (`proceed`), or `deadline` (`fail`). */
export function atDeadline(w: NormalizedWait): WaitOutcome {
  const snap = snapshot(w.agents);
  return w.onDeadline === "fail"
    ? { outcome: "deadline", selected: [], ...snap }
    : { outcome: "partial", selected: snap.settled.map((s) => s.agentId), ...snap };
}

/**
 * Re-run `check` whenever the run's bus reports a relevant change (plus a 3s safety poll), until it
 * returns a value or `timeoutMs` passes (then `onTimeout()`). Subscribe-then-check, so a change
 * that lands between the first check and the subscription can't be missed.
 */
export function waitUntil<T>(
  runId: string,
  check: () => T | null,
  opts: { timeoutMs?: number; onTimeout: () => T; events?: Set<string> },
): Promise<T> {
  const events =
    opts.events ??
    new Set(["handle_settled", "agent_ended", "agent_state_changed", "agent_spawned"]);
  return new Promise((resolve) => {
    let finished = false;
    let off = () => {};
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: T) => {
      if (finished) return;
      finished = true;
      off();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    const run = () => {
      const v = check();
      if (v !== null) finish(v);
    };
    off = onRun(runId, (msg) => {
      if (events.has(msg.event)) run();
    });
    poll = setInterval(run, 3000);
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(opts.onTimeout()), Math.max(opts.timeoutMs, 0));
    }
    run();
  });
}

/**
 * Hold a spawn until its wait resolves. Emits `wait_blocked_on_paused` (once per dependency) when a
 * dependency it's still waiting on is paused, so a stalled wait is visible rather than silent.
 */
export function waitForRegime(
  runId: string,
  waiterId: string,
  w: NormalizedWait,
): Promise<WaitOutcome> {
  const reportedPaused = new Set<string>();
  const check = () => {
    const out = evaluateWait(w);
    if (out) return out;
    for (const dep of w.agents) {
      if (reportedPaused.has(dep)) continue;
      if (getAgentRow(dep)?.state === "paused" && getHandle(dep)?.state !== "settled") {
        reportedPaused.add(dep);
        emit(runId, waiterId, "wait_blocked_on_paused", { blockedOn: dep });
      }
    }
    return null;
  };
  return waitUntil(runId, check, {
    timeoutMs: w.deadlineAt !== undefined ? w.deadlineAt - Date.now() : undefined,
    onTimeout: () => evaluateWait(w) ?? atDeadline(w),
  });
}

/**
 * Driving a turn on an agent and translating its `AgentStream` into alineod events.
 *
 * `agent.prompt()` yields structured `AgentEvent`s (text deltas, tool_start/end, turn
 * boundaries, …). We forward all of them to the SSE bus (emitHarness) and, when the turn
 * finishes, settle the agent's handle so any `waitFor` dependents unblock.
 *
 * If the stream goes quiet for `PROMPT_INACTIVITY_TIMEOUT_MS`, the SDK throws
 * `PromptTimeoutError` — but that only stops the *reader*; Pi keeps working and finishes the
 * turn (verified live, research/subtree-controls-verification.md V2). So a timeout hands the
 * turn to `catchUpTurn`, which polls Pi's state until it's really done. The same happens when
 * the timeout fires during a pause (its clock runs on this host, not in the frozen sandbox).
 */
import type { Alineo } from "alineo";
import { get } from "./registry";
import { emit, emitHarness } from "./emit";
import { writeResult } from "./results";
import { sleep, withTimeout } from "../util";
import { getAgentRow, getHandle } from "../state/projection";
import {
  CATCH_UP_POLL_MS,
  PROMPT_INACTIVITY_TIMEOUT_MS,
  STATE_PROBE_TIMEOUT_MS,
  TURN_MAX_MS,
} from "../../config";
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("alineod");

/** Agents whose turn alineod is following by reading its stream. */
const driving = new Set<string>();
/** Agents whose turn alineod is following by polling Pi's state. */
const catchingUp = new Set<string>();

/** True while alineod is following a turn on this agent, by stream or by polling. */
export function isTurnActive(agentId: string): boolean {
  return driving.has(agentId) || catchingUp.has(agentId);
}

/** True while alineod is polling a turn it stopped streaming (or reconnected to mid-turn). */
export function isCatchingUp(agentId: string): boolean {
  return catchingUp.has(agentId);
}

/** Runs in the background — callers do not await this. */
export async function driveTurn(agentId: string, message: string): Promise<void> {
  const agent = get(agentId);
  if (!agent) return;
  // alineod's run, from the projection — NOT `agent.runId`, which is the SDK's own correlation id:
  // the same for a root (alineod passes it to Alineo.load()), but a forked child picks its own,
  // which filed every event of a child's turn under a run nobody is watching.
  const runId = getAgentRow(agentId)?.run_id;
  if (!runId) return;

  setState(agentId, "running", "prompt");
  driving.add(agentId);

  try {
    for await (const ev of agent.prompt(message, {
      inactivityTimeoutMs: PROMPT_INACTIVITY_TIMEOUT_MS,
    })) {
      emitHarness(runId, agentId, ev as { type: string } & Record<string, unknown>);
    }
    const text = await safeLastText(agent);
    const resultRef = writeResult(agentId, text);
    emit(runId, agentId, "handle_settled", { outcome: "success", resultRef });
    emit(runId, agentId, "agent_ended", { outcome: "success", endedAt: Date.now() });
  } catch (err) {
    if (isStreamTimeout(err)) {
      log.warn("no stream activity — following the turn by polling instead", {
        agentId,
        inactivityMs: PROMPT_INACTIVITY_TIMEOUT_MS,
      });
      driving.delete(agentId);
      void catchUpTurn(runId, agentId, { afterStream: true });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // A failed turn may still have produced partial assistant text — keep it.
    const partial = await safeLastText(agent);
    const resultRef = writeResult(agentId, partial);
    const outcome = partial ? "success" : "failed";
    emit(runId, agentId, "handle_settled", { outcome, resultRef: partial ? resultRef : null });
    emit(runId, agentId, "agent_ended", { outcome, endedAt: Date.now(), error: message });
  } finally {
    driving.delete(agentId);
  }
}

export type TurnProbe = "streaming" | "idle" | "paused" | "unreachable" | "gone";

const CLOSED_STATES = new Set(["aborted", "lost"]);

/**
 * Where an agent's turn stands, without ever hanging. A paused agent is reported from the
 * projection — its frozen bridge can't answer, so it isn't asked. A stopped or unregistered
 * agent is `gone`. Any other bridge that doesn't answer within `STATE_PROBE_TIMEOUT_MS` is
 * `unreachable`.
 */
export async function probeTurn(agentId: string): Promise<TurnProbe> {
  const row = getAgentRow(agentId);
  const agent = get(agentId);
  if (!row || !agent || CLOSED_STATES.has(row.state)) return "gone";
  if (row.state === "paused") return "paused";
  const state = await withTimeout(agent.getState(), STATE_PROBE_TIMEOUT_MS);
  if (!state) return "unreachable";
  return state.isStreaming ? "streaming" : "idle";
}

/** Consecutive unanswered probes before catch-up stops waiting on a bridge. */
const MAX_UNREACHABLE_PROBES = 3;

/**
 * Follow a turn alineod isn't reading the stream of, by polling Pi's state until it's done,
 * then settle the handle the same way `driveTurn()` would have. Used when:
 *
 * - the stream timed out (`afterStream: true`) — Pi is usually still working;
 * - alineod reconnected to an agent that was mid-turn when the previous process died;
 * - an agent that was mid-turn is resumed after a restart (see pause.ts).
 *
 * Paused time doesn't count toward `TURN_MAX_MS`. Exits without settling if the agent is
 * stopped meanwhile, so it never overwrites `aborted`.
 *
 * Without `afterStream`, it's a no-op when the handle is already settled (the turn finished and
 * was recorded before a crash). With it, that check is skipped: a re-prompted agent's handle is
 * still settled from its previous turn.
 */
export async function catchUpTurn(
  runId: string,
  agentId: string,
  opts: { afterStream?: boolean } = {},
): Promise<void> {
  if (!opts.afterStream && getHandle(agentId)?.state === "settled") return;
  if (isTurnActive(agentId) || !get(agentId)) return;
  catchingUp.add(agentId);

  try {
    let activeMs = 0;
    let last = Date.now();
    let unreachable = 0;
    let giveUpReason: string | undefined;

    for (;;) {
      const probe = await probeTurn(agentId);
      const now = Date.now();
      if (probe !== "paused") activeMs += now - last;
      last = now;

      if (probe === "gone") return;
      if (probe === "idle") break;
      if (probe === "unreachable") {
        if (++unreachable >= MAX_UNREACHABLE_PROBES) {
          giveUpReason = "catch-up: the agent's bridge stopped answering";
          break;
        }
      } else {
        unreachable = 0;
      }
      if (activeMs >= TURN_MAX_MS) {
        giveUpReason = `catch-up: turn still running after ${TURN_MAX_MS}ms`;
        break;
      }
      await sleep(CATCH_UP_POLL_MS);
    }

    if (!opts.afterStream && getHandle(agentId)?.state === "settled") return;
    const agent = get(agentId);
    const row = getAgentRow(agentId);
    if (!agent || !row || CLOSED_STATES.has(row.state)) return; // stopped while we polled

    const text = await safeLastText(agent);
    const resultRef = writeResult(agentId, text);
    const outcome = text ? "success" : "failed";
    const error = giveUpReason ?? (text ? undefined : "catch-up: no retrievable result");
    emit(runId, agentId, "handle_settled", { outcome, resultRef: text ? resultRef : null });
    emit(runId, agentId, "agent_ended", {
      outcome,
      endedAt: Date.now(),
      ...(error ? { error } : {}),
    });
  } finally {
    catchingUp.delete(agentId);
  }
}

export function setState(agentId: string, to: string, reason?: string): void {
  const row = getAgentRow(agentId);
  const from = row?.state ?? "unknown";
  const runId = row?.run_id;
  if (!runId || from === to) return;
  emit(runId, agentId, "agent_state_changed", { from, to, ...(reason ? { reason } : {}) });
}

/** Matched by name, not `instanceof` — the SDK's error class isn't worth importing for this. */
function isStreamTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "PromptTimeoutError";
}

async function safeLastText(agent: Alineo): Promise<string | null> {
  return (await withTimeout(agent.getLastAssistantText(), STATE_PROBE_TIMEOUT_MS)) ?? null;
}

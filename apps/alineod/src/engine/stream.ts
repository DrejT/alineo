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
import { Alineo } from "alineo";
import { get, register, sdkAdapter } from "./registry";
import { emit, emitHarness } from "./emit";
import { writeResult } from "./results";
import { resolveTurnFailure } from "./supervision";
import { errorMessage, sleep, withTimeout } from "../util";
import { getAgentRow, getHandle } from "../state/projection";
import { resetFailureCounters } from "../state/db";
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

/**
 * A real process death drops these too — a fresh process's `driving`/`catchingUp` start empty.
 * Test/fault-harness seam only, mirroring `emit.ts`'s `clearSinks()`. @internal
 */
export function forgetAllTurnTrackingForFaultInjection(): void {
  driving.clear();
  catchingUp.clear();
}

/**
 * The error a turn ended on, if any. When the model API refuses a request ("overloaded", a 429,
 * a 404 for a model the account can't use) Pi stops the turn normally, with `stopReason: "error"`
 * and the provider's text in `errorMessage` on its last assistant message. The stream then ends
 * without throwing, so only this message says the agent didn't finish. Only the LAST assistant
 * message counts: Pi retries transient errors, and an earlier error that a retry got past is history.
 */
export function turnError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    } | null;
    if (m?.role !== "assistant") continue;
    if (m.stopReason !== "error") return undefined;
    return typeof m.errorMessage === "string" && m.errorMessage.trim()
      ? errorMessage(new Error(m.errorMessage))
      : "the model API returned an error";
  }
  return undefined;
}

/**
 * A `"retry"` decision re-invokes `driveTurn` for the SAME agentId the current call is still
 * unwinding from — calling it directly, inline, would have the new call's `driving.add(agentId)`
 * run before the old call's own `finally { driving.delete(agentId) }`, which would then
 * immediately (and wrongly) clear the new call's tracking. Deferring to a fresh microtask
 * guarantees the old call's finally has already run first.
 */
function deferRetry(agentId: string, message: string): void {
  queueMicrotask(() => void driveTurn(agentId, message));
}

/** Runs in the background — callers do not await this. */
export async function driveTurn(agentId: string, message: string): Promise<void> {
  const agent = get(agentId);
  if (!agent) return;
  // alineod's run, from the projection — NOT `agent.runId`, which is the SDK's own correlation id:
  // the same for a root (alineod passes it to Alineo.start()), but a forked child picks its own,
  // which filed every event of a child's turn under a run nobody is watching.
  const runId = getAgentRow(agentId)?.run_id;
  if (!runId) return;

  setState(agentId, "running", "prompt");
  driving.add(agentId);

  try {
    let endMessages: unknown;
    for await (const ev of agent.prompt(message, {
      inactivityTimeoutMs: PROMPT_INACTIVITY_TIMEOUT_MS,
    })) {
      if (ev.type === "agent_end") endMessages = (ev as { messages?: unknown }).messages;
      emitHarness(runId, agentId, ev as { type: string } & Record<string, unknown>);
    }
    const text = await safeLastText(agent);
    const resultRef = writeResult(agentId, text);
    const upstream = turnError(endMessages);
    if (upstream) {
      // The model API refused the request and Pi ended the turn. Whatever text came before is kept
      // as the result, but the agent did not finish, so it is not a success.
      const decision = resolveTurnFailure(runId, agentId, {
        error: upstream,
        resultRef: text ? resultRef : null,
        retryMessage: message,
      });
      if (decision.action === "retry") deferRetry(agentId, decision.message);
      return;
    }
    resetFailureCounters(agentId);
    emit(runId, agentId, "handle.settled", { outcome: "success", resultRef });
    emit(runId, agentId, "agent.ended", { outcome: "success", endedAt: Date.now() });
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
    if (isBridgeDisconnected(err)) {
      // The connection closed without the bridge ever signalling the turn was actually done —
      // indistinguishable from a clean finish at the stream level, so the SDK surfaces it as
      // its own error (M2.1) instead of letting it fall through to the generic catch below,
      // which would otherwise record this as a false success. Hand off to catch-up exactly
      // like a stream timeout: its probe loop will find the bridge genuinely unreachable and
      // restart it.
      log.warn(
        "bridge connection closed without signalling done — following the turn by polling instead",
        {
          agentId,
        },
      );
      driving.delete(agentId);
      void catchUpTurn(runId, agentId, { afterStream: true });
      return;
    }
    const errMessage = errorMessage(err);
    // A failed turn may still have produced partial assistant text — keep it.
    const partial = await safeLastText(agent);
    const resultRef = writeResult(agentId, partial);
    if (!partial) {
      const decision = resolveTurnFailure(runId, agentId, {
        error: errMessage,
        resultRef: null,
        retryMessage: message,
      });
      if (decision.action === "retry") deferRetry(agentId, decision.message);
    } else {
      resetFailureCounters(agentId);
      emit(runId, agentId, "handle.settled", { outcome: "success", resultRef });
      emit(runId, agentId, "agent.ended", { outcome: "success", endedAt: Date.now() });
    }
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
 * The bridge stopped answering probes, but alineod itself is still up — restart it in place
 * (durability-roadmap M2.1) instead of letting catch-up declare the turn permanently failed.
 * Mirrors rehydrate.ts's resume fallback and pause.ts's post-unpause bridge check, for the one
 * case neither covers: a live daemon whose bridge died mid-turn without the container, or
 * alineod itself, going away.
 */
async function tryRestartBridge(agentId: string): Promise<boolean> {
  const row = getAgentRow(agentId);
  const agent = get(agentId);
  if (!row || !agent) return false;
  try {
    const restarted = await Alineo.resume(agent.sandboxId, {
      adapter: sdkAdapter,
      spec: JSON.parse(row.spec_json),
      runId: row.run_id,
    });
    register(agentId, restarted);
    log.info("bridge stopped answering — restarted it", { agentId });
    return true;
  } catch (err) {
    log.warn("bridge restart failed — giving up on this turn", {
      agentId,
      error: errorMessage(err),
    });
    return false;
  }
}

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
          // alineod itself is still up — the bridge died, not the daemon. Restart it in place
          // (M2.1) rather than declaring the turn permanently failed; the next probe sees the
          // fresh process.
          if (await tryRestartBridge(agentId)) {
            emit(runId, agentId, "agent.turn_interrupted", {});
            unreachable = 0;
          } else {
            giveUpReason = "catch-up: the agent's bridge stopped answering";
            break;
          }
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
    // A turn that ended on a model API error is not a success, whatever text came before it. (Not
    // when we gave up on a turn that is still running: its last message isn't final.)
    const upstream = giveUpReason ? undefined : await safeTurnError(agent);
    const outcome = text && !upstream ? "success" : "failed";
    const error =
      giveUpReason ?? upstream ?? (text ? undefined : "catch-up: no retrievable result");
    if (outcome === "failed") {
      // No withInbox() here deliberately — that would import from notify.ts, which already
      // imports driveTurn/isTurnActive from this file; this stays a one-way dependency. Skipping
      // it just means an internal auto-retry doesn't carry pending inbox text the way an
      // externally-triggered prompt does — not a correctness issue, those still deliver on the
      // agent's next real interaction.
      const decision = resolveTurnFailure(runId, agentId, {
        error: error ?? "unknown failure",
        resultRef: text ? resultRef : null,
        retryMessage: row.prompt,
      });
      if (decision.action === "retry") deferRetry(agentId, decision.message);
    } else {
      resetFailureCounters(agentId);
      emit(runId, agentId, "handle.settled", { outcome, resultRef: text ? resultRef : null });
      // `error` can be set even on a "success" settle here — e.g. catch-up gave up on a turn
      // that was still running (giveUpReason) but kept its partial text; that explanation is
      // still worth recording even though the outcome itself is a success.
      emit(runId, agentId, "agent.ended", {
        outcome,
        endedAt: Date.now(),
        ...(error ? { error } : {}),
      });
    }
  } finally {
    catchingUp.delete(agentId);
  }
}

export function setState(agentId: string, to: string, reason?: string): void {
  const row = getAgentRow(agentId);
  const from = row?.state ?? "unknown";
  const runId = row?.run_id;
  if (!runId || from === to) return;
  emit(runId, agentId, "agent.state_changed", { from, to, ...(reason ? { reason } : {}) });
}

/** Matched by name, not `instanceof` — the SDK's error class isn't worth importing for this. */
function isStreamTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "PromptTimeoutError";
}

/** Matched by name, same reasoning as `isStreamTimeout` above. */
function isBridgeDisconnected(err: unknown): boolean {
  return err instanceof Error && err.name === "BridgeDisconnectedError";
}

async function safeTurnError(agent: Alineo): Promise<string | undefined> {
  return turnError(await withTimeout(agent.getMessages(), STATE_PROBE_TIMEOUT_MS));
}

async function safeLastText(agent: Alineo): Promise<string | null> {
  return (await withTimeout(agent.getLastAssistantText(), STATE_PROBE_TIMEOUT_MS)) ?? null;
}

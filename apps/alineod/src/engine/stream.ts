/**
 * Driving a turn on an agent and translating its `AgentStream` into alineod events.
 *
 * `agent.prompt()` yields structured `AgentEvent`s (text deltas, tool_start/end, turn
 * boundaries, …). We forward all of them to the SSE bus (emitHarness) and, when the turn
 * finishes, settle the agent's handle so any `waitFor` dependents unblock.
 */
import type { Alineo } from "alineo";
import { get } from "./registry";
import { emit, emitHarness } from "./emit";
import { writeResult } from "./results";
import { getAgentRow, getHandle } from "../state/projection";
import { PROMPT_INACTIVITY_TIMEOUT_MS } from "../../config";

/** Runs in the background — callers do not await this. */
export async function driveTurn(agentId: string, message: string): Promise<void> {
  const agent = get(agentId);
  if (!agent) return;
  const runId = agent.runId;

  setState(agentId, "running", "prompt");

  try {
    for await (const ev of agent.prompt(message, { inactivityTimeoutMs: PROMPT_INACTIVITY_TIMEOUT_MS })) {
      emitHarness(runId, agentId, ev as { type: string } & Record<string, unknown>);
    }
    const text = await safeLastText(agent);
    const resultRef = writeResult(agentId, text);
    emit(runId, agentId, "handle_settled", { outcome: "success", resultRef });
    emit(runId, agentId, "agent_ended", { outcome: "success", endedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A stalled / timed-out turn may still have produced partial assistant text — keep it.
    const partial = await safeLastText(agent);
    const resultRef = writeResult(agentId, partial);
    const outcome = partial ? "success" : "failed";
    emit(runId, agentId, "handle_settled", { outcome, resultRef: partial ? resultRef : null });
    emit(runId, agentId, "agent_ended", { outcome, endedAt: Date.now(), error: message });
  }
}

/**
 * After a reattach, alineod has a live agent handle but no active reader of its stream — the
 * original `driveTurn()` loop that would have settled the handle died with the old process.
 * If that agent was mid-turn at crash time, poll Pi's own state (`isStreaming`) until it's
 * done, then settle the handle the same way `driveTurn()` would have. No-op if the handle
 * already settled some other way (e.g. the turn genuinely finished and got recorded before
 * the crash — a race, but a harmless one to check for).
 */
export async function catchUpTurn(runId: string, agentId: string): Promise<void> {
  if (getHandle(agentId)?.state === "settled") return;
  const agent = get(agentId);
  if (!agent) return;

  const deadline = Date.now() + PROMPT_INACTIVITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const state = await agent.getState();
      if (!state.isStreaming) break;
    } catch {
      break; // bridge stopped answering mid-poll -- settle on whatever's readable below
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }

  if (getHandle(agentId)?.state === "settled") return;

  const text = await safeLastText(agent);
  const resultRef = writeResult(agentId, text);
  const outcome = text ? "success" : "failed";
  emit(runId, agentId, "handle_settled", { outcome, resultRef: text ? resultRef : null });
  emit(runId, agentId, "agent_ended", {
    outcome,
    endedAt: Date.now(),
    ...(text ? {} : { error: "reattach catch-up: no retrievable result" }),
  });
}

export function setState(agentId: string, to: string, reason?: string): void {
  const row = getAgentRow(agentId);
  const from = row?.state ?? "unknown";
  const runId = row?.run_id;
  if (!runId || from === to) return;
  emit(runId, agentId, "agent_state_changed", { from, to, ...(reason ? { reason } : {}) });
}

async function safeLastText(agent: Alineo): Promise<string | null> {
  try {
    return await agent.getLastAssistantText();
  } catch {
    return null;
  }
}

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
import { getAgentRow } from "../state/projection";

/** Runs in the background — callers do not await this. */
export async function driveTurn(agentId: string, message: string): Promise<void> {
  const agent = get(agentId);
  if (!agent) return;
  const runId = agent.runId;

  setState(agentId, "running", "prompt");

  try {
    for await (const ev of agent.prompt(message)) {
      emitHarness(runId, agentId, ev as { type: string } & Record<string, unknown>);
    }
    const text = await safeLastText(agent);
    const resultRef = writeResult(agentId, text);
    emit(runId, agentId, "handle_settled", { outcome: "success", resultRef });
    emit(runId, agentId, "agent_ended", { outcome: "success", endedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeResult(agentId, null);
    emit(runId, agentId, "handle_settled", { outcome: "failed", resultRef: null });
    emit(runId, agentId, "agent_ended", { outcome: "failed", endedAt: Date.now(), error: message });
  }
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

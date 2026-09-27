/**
 * Waiting on another agent to leave `paused`. Used before forking from a parent: OpenSandbox
 * refuses to snapshot a paused sandbox (`SNAPSHOT::INVALID_SOURCE_STATE`, verified live —
 * research/subtree-controls-verification.md V1), so a spawn under a paused parent waits for
 * the resume instead of failing.
 */
import { onRun } from "../bus";
import { getAgentRow } from "../state/projection";

/**
 * Resolves once `agentId` is no longer paused — resumed, or ended. Subscribe-then-check (same
 * as `waitForHandles`) so a resume that lands in between can't be missed, plus a slow poll in
 * case a bus message is ever dropped.
 */
export function waitUntilNotPaused(runId: string, agentId: string): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {};
    let poll: ReturnType<typeof setInterval> | undefined;

    const check = () => {
      if (getAgentRow(agentId)?.state === "paused") return;
      off();
      if (poll) clearInterval(poll);
      resolve();
    };

    off = onRun(runId, (msg) => {
      if (msg.event !== "agent.state_changed" && msg.event !== "agent.ended") return;
      if ((msg.data as { agentId?: string } | null)?.agentId === agentId) check();
    });
    poll = setInterval(check, 3000);
    check();
  });
}

/** OpenSandbox's refusal to fork a sandbox that isn't running. */
export function isNotRunningError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /INVALID_SOURCE_STATE|can only be created from a Running sandbox/i.test(message);
}

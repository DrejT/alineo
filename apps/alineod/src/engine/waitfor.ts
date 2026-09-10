/**
 * `waitFor` — hold until every named agent's handle is settled (research/daemon.md §8, D-c
 * "hold-then-spawn"). The wait graph is a DAG by construction (you can only wait on agents
 * that already exist), so there is no deadlock detection in v0.
 */
import { onRun } from "../bus";
import { getHandle } from "../state/projection";

export function waitForHandles(runId: string, ids: string[]): Promise<void> {
  const pending = new Set(ids);
  for (const id of ids) {
    if (getHandle(id)?.state === "settled") pending.delete(id);
  }
  if (pending.size === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const off = onRun(runId, (msg) => {
      if (msg.event !== "handle_settled") return;
      const settledId = (msg.data as { agentId?: string }).agentId;
      if (settledId && pending.delete(settledId) && pending.size === 0) {
        off();
        resolve();
      }
    });
  });
}

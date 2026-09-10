/**
 * `waitFor` — hold until every named agent's handle is settled (research/daemon.md §8, D-c
 * "hold-then-spawn"). The wait graph is a DAG by construction (you can only wait on agents
 * that already exist), so there is no deadlock detection in v0.
 */
import { onRun } from "../bus";
import { getHandle } from "../state/projection";

export function waitForHandles(runId: string, ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    const pending = new Set(ids);
    let off = () => {};
    let poll: ReturnType<typeof setInterval> | undefined;

    const check = () => {
      for (const id of [...pending]) {
        if (getHandle(id)?.state === "settled") pending.delete(id);
      }
      if (pending.size === 0) {
        off();
        if (poll) clearInterval(poll);
        resolve();
      }
    };

    // Subscribe BEFORE the first check so a handle that settles in the gap can't be missed
    // (the listener just re-runs check(), which is idempotent).
    off = onRun(runId, (msg) => {
      if (msg.event === "handle_settled" || msg.event === "agent_ended") check();
    });
    poll = setInterval(check, 3000); // safety net if a bus message is ever dropped
    check();
  });
}

/**
 * `GET /agents/:agentId/result` — resolve a handle.
 *   settled           → 200 { outcome, resultRef, result }
 *   pending, no wait   → 202 { state: "pending" }
 *   pending, ?wait=N   → server-held up to N seconds, then whichever of the above applies
 */
import { Elysia } from "elysia";
import { getHandle, getAgentRow } from "../state/projection";
import { readResult } from "../engine/results";
import { onRun } from "../bus";
import { HttpError } from "../engine/errors";
import { MAX_RESULT_WAIT_SECONDS } from "../../config";

export const resultsRoutes = new Elysia().get("/agents/:agentId/result", async ({ params, query, set }) => {
  const row = getAgentRow(params.agentId);
  if (!row) throw new HttpError(404, `no agent ${params.agentId}`);

  let handle = getHandle(params.agentId);

  const waitSeconds = Math.min(Number(query.wait ?? "0") || 0, MAX_RESULT_WAIT_SECONDS);
  if ((!handle || handle.state === "pending") && waitSeconds > 0) {
    await waitForSettle(row.run_id, params.agentId, waitSeconds * 1000);
    handle = getHandle(params.agentId);
  }

  if (!handle || handle.state === "pending") {
    set.status = 202;
    return { agentId: params.agentId, state: "pending", outcome: null, resultRef: null, result: null };
  }

  return {
    agentId: params.agentId,
    state: "settled" as const,
    outcome: handle.outcome,
    resultRef: handle.result_ref,
    result: readResult(params.agentId),
  };
});

function waitForSettle(runId: string, agentId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    const off = onRun(runId, (msg) => {
      if (msg.event === "handle_settled" && (msg.data as { agentId?: string }).agentId === agentId) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

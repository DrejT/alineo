/**
 * The sweep. Two jobs, both off until the operator turns them on:
 *
 * - Tear down an open run that has outlived the tenant's `maxRunAgeMs`.
 * - Tear down every open run of a tenant the kill switch says is suspended.
 *
 * Teardown is `deleteRun`, the same call a client's `DELETE /runs/:id` makes, so the ledger is
 * kept and the run can still be read afterward. A run that fails to come down is logged and tried
 * again on the next sweep.
 */
import { getLogger } from "@alineo-labs/logger";
import { DEFAULT_TENANT } from "../auth";
import type { Limits } from "../limits";
import { openRunsWithAge } from "../state/projection";
import { errorMessage } from "../util";
import { deleteRun } from "./lifecycle";

const log = getLogger("alineod");

/** One pass. Returns the runs it tore down, with why. Exported so tests can call it directly. */
export async function sweepOnce(
  limits: Limits,
  now = Date.now(),
): Promise<Array<{ runId: string; tenant: string; reason: "age" | "suspended" }>> {
  const torn: Array<{ runId: string; tenant: string; reason: "age" | "suspended" }> = [];
  const suspended = new Map<string, boolean>();
  const limitsOf = new Map<string, number | undefined>();

  for (const run of openRunsWithAge(DEFAULT_TENANT)) {
    let reason: "age" | "suspended" | null = null;
    try {
      if (!suspended.has(run.tenant)) suspended.set(run.tenant, await limits.suspended(run.tenant));
      if (suspended.get(run.tenant)) {
        reason = "suspended";
      } else {
        if (!limitsOf.has(run.tenant)) {
          limitsOf.set(run.tenant, (await limits.resolve(run.tenant)).maxRunAgeMs);
        }
        const maxAge = limitsOf.get(run.tenant);
        if (maxAge !== undefined && run.createdAt !== null && now - run.createdAt > maxAge) {
          reason = "age";
        }
      }
    } catch (err) {
      // A broken policy function must not tear runs down by accident. Leave this one alone.
      log.error("limits check failed during sweep", { runId: run.runId, error: errorMessage(err) });
      continue;
    }
    if (reason === null) continue;
    try {
      await deleteRun(run.runId);
      torn.push({ runId: run.runId, tenant: run.tenant, reason });
      log.info("run torn down by the sweep", { runId: run.runId, tenant: run.tenant, reason });
    } catch (err) {
      log.warn("could not tear down a run; will retry", {
        runId: run.runId,
        error: errorMessage(err),
      });
    }
  }
  return torn;
}

/** Run the sweep every `intervalMs`. Skips a tick if the last one is still going. */
export function startSweeper(limits: Limits, intervalMs: number): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepOnce(limits)
      .catch((err: unknown) => log.error("sweep failed", { error: errorMessage(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Never keep the process alive just for the sweep.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

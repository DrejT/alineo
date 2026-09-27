/**
 * One-time rename of the `event` column from the old flat names to the namespaced ones.
 *
 * **Idempotent by construction**, matching how every other migration in this repo works —
 * there is no `schema_version` table anywhere, just `CREATE TABLE IF NOT EXISTS` and
 * try/catch `ALTER`. `UPDATE … WHERE event = 'agent_spawned'` matches nothing on a second
 * run, so it is safe at every boot with no version tracking to get out of step.
 *
 * **One pass, not one per name.** A `CASE` over a single scan replaces what would otherwise
 * be ~40 `UPDATE`s. `ledger` is indexed on `(run_id, seq)` and `(agent_id, event, seq)`, so
 * a bare `WHERE event = ?` is not the index's leading column — each separate UPDATE would
 * scan. On a long-lived swarm database that is the difference between a boot pause and a
 * boot hang.
 *
 * The mapping comes from `@alineo-labs/schema`'s rename table rather than being retyped, so
 * a name that changes in one place cannot be missed here. The table is dated and deletable:
 * once no deployed database predates this rename, both it and this file go.
 *
 * **This is one-way.** A rollback to an older alineod would meet renamed rows it cannot fold.
 */
import type { Database } from "bun:sqlite";
import { RENAMED_EVENTS } from "@alineo-labs/schema";

/**
 * alineod's ledger holds its own events plus forwarded harness ones. It never held the
 * workflow layer's, so `checkpoint`/`snapshot`/`step_*` are not in scope — mapping them here
 * would rewrite rows that cannot exist, and would be wrong if they somehow did.
 */
const NOT_IN_THIS_STORE = new Set([
  "workflow_complete",
  "workflow_failed",
  "step_start",
  "step_complete",
  "step_failed",
  "step_rolled_back",
  "checkpoint",
  "snapshot",
  "sandbox_created",
  "sandbox_closed",
  "sandbox_paused",
  "sandbox_resumed",
  "checkpoint_created",
  "exec_start",
  "exec_event",
  "exec_complete",
  "egress_rule_added",
  "egress_rule_removed",
  "credential_bound",
  "credential_revoked",
]);

/** The pairs this store rewrites: alineod's own events plus the harness stream it forwards. */
export function eventRenames(): [string, string][] {
  const pairs = Object.entries(RENAMED_EVENTS).filter(([old]) => !NOT_IN_THIS_STORE.has(old));
  // `run_started` is the one name the shared table deliberately leaves unmapped, because it
  // meant a workflow run in one store and a swarm run in another. Here it is always the swarm.
  pairs.push(["run_started", "run.started"]);
  return pairs;
}

export function migrateEventNames(db: Database): number {
  const pairs = eventRenames();
  const cases = pairs.map(() => "WHEN event = ? THEN ?").join(" ");
  const params = pairs.flat();
  const result = db.run(
    `UPDATE ledger SET event = CASE ${cases} ELSE event END
     WHERE event IN (${pairs.map(() => "?").join(", ")})`,
    [...params, ...pairs.map(([old]) => old)],
  );
  return result.changes;
}

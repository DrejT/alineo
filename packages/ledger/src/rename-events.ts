/**
 * One-time rename of `alineo_events.event` from the old flat names to the namespaced ones.
 *
 * **Idempotent by construction**, matching every other migration here — there is no
 * `schema_version` table anywhere in this repo, so `WHERE event IN (…old names…)` matching
 * nothing on a second run *is* the version check.
 *
 * **One pass, not one per name.** `event` is **unindexed** on this table (only `sandbox_id`
 * and `name` are), so each separate `UPDATE` would be a full scan. A `CASE` over one scan
 * replaces roughly twenty-five of them. This is a one-time boot cost either way, but there is
 * no reason for it to be accidentally quadratic on a large ledger.
 *
 * **This is one-way.** An older SDK reading a migrated database would find event names it
 * does not recognise, and `getSandboxDetails` — which aggregates on `event = 'sandbox.created'`
 * and friends — would return nothing rather than fail loudly.
 */
import { RENAMED_EVENTS } from "@alineo-labs/schema";

/**
 * The pairs this store rewrites.
 *
 * `alineo_events` holds the substrate, agent and workflow layers — everything the SDK itself
 * writes. It has never held alineod's swarm events or the harness stream, which live in
 * alineod's own database, so those are excluded: rewriting rows that cannot exist is at best
 * wasted work and at worst wrong about which store owns a name.
 */
const NOT_IN_THIS_STORE = new Set([
  "agent_spawned",
  "agent_provisioned",
  "agent_state_changed",
  "agent_steered",
  "agent_released",
  "agent_ended",
  "handle_settled",
  "wait_resolved",
  "wait_blocked_on_paused",
  "inbox_queued",
  "inbox_delivered",
  "inbox_dropped",
  "notify_registered",
  "budget_denied",
  "subtree_quiescent",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "message_start",
  "message_update",
  "message_end",
  "text",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "queue_update",
  "extension_ui",
  "extension_error",
  "permission_request",
]);

export function eventRenames(): [string, string][] {
  const pairs = Object.entries(RENAMED_EVENTS).filter(([old]) => !NOT_IN_THIS_STORE.has(old));
  // The shared table leaves `run_started` unmapped because it meant two different events.
  // In this store it is always the workflow engine's run; alineod's lives elsewhere.
  pairs.push(["run_started", "workflow.started"]);
  return pairs;
}

/**
 * The single-pass UPDATE, and its parameters.
 *
 * Lives here rather than in either adapter because both need it and neither should depend on
 * the other. It returns SQL and parameters rather than running anything — placeholders are
 * `?`, which the postgres adapter renumbers to `$1`-style on its way in. No driver, no
 * connection, nothing engine-specific.
 */
export function renameEventsStatement(): { sql: string; params: string[] } {
  const pairs = eventRenames();
  const cases = pairs.map(() => "WHEN event = ? THEN ?").join(" ");
  const placeholders = pairs.map(() => "?").join(", ");
  return {
    // The ELSE is load-bearing: without it, every row not matched by the CASE would be
    // rewritten to NULL.
    sql: `UPDATE alineo_events SET event = CASE ${cases} ELSE event END
          WHERE event IN (${placeholders})`,
    params: [...pairs.flat(), ...pairs.map(([old]) => old)],
  };
}

/**
 * The old flat event names, and what each became.
 *
 * This table is **dated and deletable**, not a standing feature. An earlier draft carried a
 * `legacy` field on every definition so both names kept being written forever; that was
 * dropped because a permanent two-names-per-event alias costs more than the break. The
 * mapping survives here only because three stores hold old names in an `event` column and
 * need a one-time migration — once no deployed database predates the rename, this file goes.
 *
 * Nothing reads it at runtime on the hot path. Its consumers are the store migrations and
 * the test that proves every old name maps to a registered event.
 */
export const RENAMED_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  // ── substrate (packages/core) ──
  sandbox_created: "sandbox.created",
  sandbox_closed: "sandbox.closed",
  sandbox_paused: "sandbox.paused",
  sandbox_resumed: "sandbox.resumed",
  checkpoint_created: "sandbox.checkpoint_created",
  exec_start: "exec.started",
  exec_event: "exec.output",
  exec_complete: "exec.completed",
  egress_rule_added: "egress.rule_added",
  egress_rule_removed: "egress.rule_removed",
  credential_bound: "credential.bound",
  credential_revoked: "credential.revoked",

  // ── agent SDK ──
  permission_requested: "permission.requested",
  permission_resolved: "permission.resolved",
  permission_request: "permission.requested",

  // ── workflow ──
  // `run_started` is deliberately absent: it meant a workflow run in one store and a swarm
  // run in another, so a single mapping would be wrong in one of them. Each store's
  // migration resolves it from its own context — see the note in the migration files.
  workflow_complete: "workflow.completed",
  workflow_failed: "workflow.failed",
  step_start: "step.started",
  step_complete: "step.completed",
  step_failed: "step.failed",
  step_rolled_back: "step.rolled_back",
  checkpoint: "step.checkpointed",
  // `snapshot` is dropped, not renamed — it recorded a sandbox checkpoint the workflow engine
  // happened to take, so it folds into the event that already describes that.
  snapshot: "sandbox.checkpoint_created",

  // ── swarm control plane (alineod) ──
  agent_spawned: "agent.spawned",
  agent_provisioned: "agent.provisioned",
  agent_state_changed: "agent.state_changed",
  agent_steered: "agent.steered",
  agent_released: "agent.released",
  agent_ended: "agent.ended",
  handle_settled: "handle.settled",
  wait_resolved: "wait.resolved",
  wait_blocked_on_paused: "wait.blocked",
  inbox_queued: "inbox.queued",
  inbox_delivered: "inbox.delivered",
  inbox_dropped: "inbox.dropped",
  notify_registered: "notify.registered",
  budget_denied: "budget.denied",
  subtree_quiescent: "run.quiescent",

  // ── harness stream ──
  agent_start: "session.started",
  agent_end: "session.ended",
  turn_start: "turn.started",
  turn_end: "turn.ended",
  tool_start: "tool.started",
  tool_update: "tool.updated",
  tool_end: "tool.ended",
  message_start: "message.started",
  message_update: "message.updated",
  message_end: "message.ended",
  text: "message.updated",
  compaction_start: "compaction.started",
  compaction_end: "compaction.ended",
  auto_retry_start: "retry.started",
  auto_retry_end: "retry.ended",
  queue_update: "queue.updated",
  extension_ui: "extension.ui",
  extension_error: "extension.error",
});

/**
 * The new name for an old one, or `undefined` if the name was never renamed.
 *
 * `run_started` returns `undefined` on purpose — it is the one name that meant two different
 * events, so the caller's own context decides.
 */
export function renamedEventType(old: string): string | undefined {
  return RENAMED_EVENTS[old];
}

/**
 * The materialized projections over `ledger` — `agents` (the spawn tree, flat list + parent
 * pointers) and `handles` (one row per agent another agent can wait on).
 *
 * `apply()` is called on every appended row and is the ONLY writer of these two tables, so
 * they stay a pure function of the ledger and `rebuild()` can throw them away and refold.
 */
import { db, readAllLedger, type LedgerRow } from "./db";
import type { AgentView } from "../schema";

// ── writers (ledger-driven only) ─────────────────────────────────────────────

const upsertAgent = db.query(
  `INSERT INTO agents
     (agent_id, run_id, parent_agent_id, depth, spawn_index, state, spec_name, spec_json, sandbox_id,
      spawn_budget, max_agents_budget, wait_for, prompt, created_at)
   VALUES ($agentId, $runId, $parentAgentId, $depth, $spawnIndex, 'provisioning', $specName, $specJson, $sandboxId,
      $spawnBudget, $maxAgentsBudget, $waitFor, $prompt, $createdAt)
   ON CONFLICT(agent_id) DO NOTHING`,
);

const setAgentState = db.query(`UPDATE agents SET state = $state WHERE agent_id = $agentId`);

const setPausedFrom = db.query(
  `UPDATE agents SET paused_from = $pausedFrom, paused_by = $pausedBy WHERE agent_id = $agentId`,
);

const clearPausedBy = db.query(`UPDATE agents SET paused_by = NULL WHERE agent_id = $agentId`);

const markReleased = db.query(
  `UPDATE agents SET released_at = $at WHERE agent_id = $agentId AND released_at IS NULL`,
);

const upsertSubscription = db.query(
  `INSERT INTO notify_subscriptions (subscriber_id, on_agent_id, run_id, wake)
   VALUES ($subscriber, $on, $runId, $wake)
   ON CONFLICT(subscriber_id, on_agent_id) DO UPDATE SET wake = excluded.wake`,
);

const insertInbox = db.query(
  `INSERT OR IGNORE INTO inbox
     (seq, run_id, agent_id, kind, about_agent_id, about_spec, outcome, result_ref, excerpt, again, text)
   VALUES ($seq, $runId, $agentId, $kind, $about, $aboutSpec, $outcome, $resultRef, $excerpt, $again, $text)`,
);

const settleInbox = db.query(
  `UPDATE inbox SET state = $state, delivered_as = $as, settled_at = $at
   WHERE seq = $seq AND state = 'pending'`,
);

const setAgentSandbox = db.query(
  `UPDATE agents SET sandbox_id = $sandboxId WHERE agent_id = $agentId`,
);

const endAgentRow = db.query(
  `UPDATE agents SET state = $state, outcome = $outcome, ended_at = $endedAt WHERE agent_id = $agentId`,
);

const upsertHandlePending = db.query(
  `INSERT INTO handles (agent_id, run_id, state) VALUES ($agentId, $runId, 'pending')
   ON CONFLICT(agent_id) DO NOTHING`,
);

const settleHandleRow = db.query(
  `UPDATE handles SET state = 'settled', outcome = $outcome, result_ref = $resultRef, settled_at = $settledAt
   WHERE agent_id = $agentId`,
);

// Safety net for an agent that ended without an explicit handle_settled — must NOT clobber a
// handle that a prior handle_settled already resolved (that one carries the real resultRef).
const settleHandleIfPending = db.query(
  `UPDATE handles SET state = 'settled', outcome = $outcome, settled_at = $settledAt
   WHERE agent_id = $agentId AND state = 'pending'`,
);

/** Fold one ledger row into the projections. Unknown / forwarded harness events are ignored. */
export function apply(row: LedgerRow): void {
  const p = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
  switch (row.event) {
    case "agent.spawned": {
      upsertAgent.run({
        $agentId: row.agent_id,
        $runId: row.run_id,
        $parentAgentId: (p.parentAgentId as string | null) ?? null,
        $depth: (p.depth as number) ?? 0,
        $spawnIndex: (p.spawnIndex as number) ?? 0,
        $specName: (p.specName as string) ?? "",
        $specJson: (p.specJson as string) ?? "{}",
        $sandboxId: (p.sandboxId as string | null) ?? null,
        $spawnBudget: (p.spawnBudget as number | null) ?? null,
        $maxAgentsBudget: (p.maxAgentsBudget as number | null) ?? null,
        $waitFor: p.waitFor ? JSON.stringify(p.waitFor) : null,
        $prompt: (p.prompt as string | null) ?? null,
        $createdAt: row.ts,
      });
      upsertHandlePending.run({ $agentId: row.agent_id, $runId: row.run_id });
      break;
    }
    case "agent.state_changed":
      setAgentState.run({ $agentId: row.agent_id, $state: p.to as string });
      if (p.to === "paused") {
        setPausedFrom.run({
          $agentId: row.agent_id,
          $pausedFrom: (p.from as string) ?? null,
          $pausedBy: (p.pausedBy as string | undefined) ?? "operator",
        });
      } else if (p.from === "paused") {
        clearPausedBy.run({ $agentId: row.agent_id });
      }
      break;
    case "agent.provisioned":
      setAgentSandbox.run({ $agentId: row.agent_id, $sandboxId: p.sandboxId as string });
      break;
    case "handle.settled":
      settleHandleRow.run({
        $agentId: row.agent_id,
        $outcome: (p.outcome as string) ?? null,
        $resultRef: (p.resultRef as string | null) ?? null,
        $settledAt: row.ts,
      });
      break;
    case "notify.registered":
      for (const on of (p.on as string[] | undefined) ?? []) {
        upsertSubscription.run({
          $subscriber: row.agent_id,
          $on: on,
          $runId: row.run_id,
          $wake: p.wake ? 1 : 0,
        });
      }
      break;
    case "inbox.queued":
      insertInbox.run({
        $seq: row.seq,
        $runId: row.run_id,
        $agentId: row.agent_id,
        $kind: (p.kind as string) ?? "notification",
        $about: (p.aboutAgentId as string | null) ?? null,
        $aboutSpec: (p.aboutSpec as string | null) ?? null,
        $outcome: (p.outcome as string | null) ?? null,
        $resultRef: (p.resultRef as string | null) ?? null,
        $excerpt: (p.excerpt as string | null) ?? null,
        $again: p.again ? 1 : 0,
        $text: (p.text as string | null) ?? null,
      });
      break;
    case "inbox.delivered":
    case "inbox.dropped":
      for (const seq of (p.seqs as number[] | undefined) ?? []) {
        settleInbox.run({
          $seq: seq,
          $state: row.event === "inbox.delivered" ? "delivered" : "dropped",
          $as: ((row.event === "inbox.delivered" ? p.as : p.reason) as string | undefined) ?? null,
          $at: row.ts,
        });
      }
      break;
    case "agent.released":
      if (row.agent_id) markReleased.run({ $agentId: row.agent_id, $at: row.ts });
      break;
    case "agent.ended":
      endAgentRow.run({
        $agentId: row.agent_id,
        $state: mapOutcomeToState((p.outcome as string) ?? "failed"),
        $outcome: (p.outcome as string) ?? "failed",
        $endedAt: row.ts,
      });
      settleHandleIfPending.run({
        $agentId: row.agent_id,
        $outcome: (p.outcome as string) ?? "failed",
        $settledAt: row.ts,
      });
      break;
  }
}

function mapOutcomeToState(outcome: string): string {
  switch (outcome) {
    case "success":
      return "done";
    case "aborted":
      return "aborted";
    case "lost":
      return "lost";
    case "budget-exceeded":
      return "failed";
    default:
      return "failed";
  }
}

/** Wipe and refold from the whole ledger. Called once at boot. */
export function rebuild(): void {
  db.exec(
    "DELETE FROM agents; DELETE FROM handles; DELETE FROM notify_subscriptions; DELETE FROM inbox;",
  );
  for (const row of readAllLedger()) apply(row);
}

// ── readers ─────────────────────────────────────────────────────────────────

const rowToView = (r: AgentRow): AgentView => ({
  agentId: r.agent_id,
  runId: r.run_id,
  parentAgentId: r.parent_agent_id,
  depth: r.depth,
  spawnIndex: r.spawn_index,
  state: r.state,
  specName: r.spec_name,
  sandboxId: r.sandbox_id,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  outcome: r.outcome,
  pausedBy: r.paused_by,
});

export interface AgentRow {
  agent_id: string;
  run_id: string;
  parent_agent_id: string | null;
  depth: number;
  spawn_index: number;
  state: string;
  spec_name: string;
  spec_json: string;
  sandbox_id: string | null;
  spawn_budget: number | null;
  max_agents_budget: number | null;
  wait_for: string | null;
  prompt: string | null;
  paused_from: string | null;
  paused_by: string | null;
  created_at: number;
  ended_at: number | null;
  outcome: string | null;
  released_at: number | null;
}

const qAgent = db.query<AgentRow, [string]>(`SELECT * FROM agents WHERE agent_id = ?`);
const qRunAgents = db.query<AgentRow, [string]>(
  `SELECT * FROM agents WHERE run_id = ? ORDER BY depth ASC, spawn_index ASC`,
);
const qChildCount = db.query<{ n: number }, [string]>(
  `SELECT COUNT(*) AS n FROM agents WHERE parent_agent_id = ?`,
);
const qMaxSeq = db.query<{ m: number | null }, [string]>(
  `SELECT MAX(seq) AS m FROM ledger WHERE run_id = ?`,
);
const qAgentsByState = db.query<AgentRow, []>(`SELECT * FROM agents`);

export function getAgentRow(agentId: string): AgentRow | null {
  return qAgent.get(agentId) ?? null;
}

export function getAgentView(agentId: string): AgentView | null {
  const r = qAgent.get(agentId);
  return r ? rowToView(r) : null;
}

export function getRunAgentViews(runId: string): AgentView[] {
  return qRunAgents.all(runId).map(rowToView);
}

export function childCount(parentAgentId: string): number {
  return qChildCount.get(parentAgentId)?.n ?? 0;
}

// An agent plus every descendant, parents before children (`depth`, then `spawn_index`).
const qSubtree = db.query<AgentRow, [string]>(
  `WITH RECURSIVE sub(agent_id) AS (
     SELECT agent_id FROM agents WHERE agent_id = ?
     UNION ALL
     SELECT a.agent_id FROM agents a JOIN sub ON a.parent_agent_id = sub.agent_id
   )
   SELECT agents.* FROM agents JOIN sub USING (agent_id) ORDER BY depth ASC, spawn_index ASC`,
);

/** `subtree(agentId)` (research/swarm-control.md §5a): the agent and all its descendants. */
export function resolveSubtree(agentId: string): AgentRow[] {
  return qSubtree.all(agentId);
}

/** True if any ancestor of the agent (not the agent itself) is paused. */
export function hasPausedAncestor(agentId: string): boolean {
  let parentId = getAgentRow(agentId)?.parent_agent_id ?? null;
  while (parentId) {
    const parent = getAgentRow(parentId);
    if (!parent) return false;
    if (parent.state === "paused") return true;
    parentId = parent.parent_agent_id;
  }
  return false;
}

export function runAsOf(runId: string): number {
  return qMaxSeq.get(runId)?.m ?? 0;
}

const LIVE_STATES = new Set(["provisioning", "running", "spawning", "paused"]);

export function liveAgents(): AgentRow[] {
  return qAgentsByState.all().filter((r) => LIVE_STATES.has(r.state));
}

/**
 * Finished agents whose sandbox is still open — a turn that ended in `done` or `failed`
 * does NOT close the sandbox (see stream.ts's driveTurn), so it stays promptable and usable as
 * a spawn parent for the rest of the process's life. `liveAgents()` alone misses these on a
 * fresh process (their state isn't "live"), which is what rehydrate.ts uses this for: without
 * it, a restarted alineod has no connection object for them at all, and every route that
 * checks `registry.get(agentId)` — prompt, steer, pause, spawn-as-parent — would 409 forever,
 * even though the container is right there.
 *
 * Excludes `aborted` (stop/deleteRun call `agent.close()` — the sandbox really is gone) and
 * `lost` (rehydrate itself already gave up on it; retried the same way next boot, not this one).
 */
const CLOSED_OUTCOMES = new Set(["aborted", "lost"]);

export function reconnectableTerminalAgents(): AgentRow[] {
  return qAgentsByState
    .all()
    .filter(
      (r) =>
        !LIVE_STATES.has(r.state) &&
        r.sandbox_id !== null &&
        r.released_at === null &&
        !CLOSED_OUTCOMES.has(r.outcome ?? ""),
    );
}

// ── notifications ───────────────────────────────────────────────────────────

export interface SubscriptionRow {
  subscriber_id: string;
  on_agent_id: string;
  run_id: string;
  wake: number;
}

export interface InboxRow {
  seq: number;
  run_id: string;
  agent_id: string;
  kind: "notification" | "steer";
  about_agent_id: string | null;
  about_spec: string | null;
  outcome: string | null;
  result_ref: string | null;
  excerpt: string | null;
  again: number;
  text: string | null;
  state: "pending" | "delivered" | "dropped";
  delivered_as: string | null;
  settled_at: number | null;
}

const qSubscribersOf = db.query<SubscriptionRow, [string]>(
  `SELECT * FROM notify_subscriptions WHERE on_agent_id = ?`,
);
const qSubscription = db.query<SubscriptionRow, [string, string]>(
  `SELECT * FROM notify_subscriptions WHERE subscriber_id = ? AND on_agent_id = ?`,
);
const qInbox = db.query<InboxRow, [string]>(`SELECT * FROM inbox WHERE agent_id = ? ORDER BY seq`);
const qPendingInbox = db.query<InboxRow, [string]>(
  `SELECT * FROM inbox WHERE agent_id = ? AND state = 'pending' ORDER BY seq`,
);
const qNotifiedBefore = db.query<{ n: number }, [string, string]>(
  `SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND about_agent_id = ? AND kind = 'notification'`,
);
const qAgentsWithPending = db.query<{ agent_id: string }, []>(
  `SELECT DISTINCT agent_id FROM inbox WHERE state = 'pending'`,
);

export const subscribersOf = (agentId: string) => qSubscribersOf.all(agentId);
export const subscription = (subscriberId: string, onAgentId: string) =>
  qSubscription.get(subscriberId, onAgentId) ?? null;
export const inboxOf = (agentId: string) => qInbox.all(agentId);
export const pendingInbox = (agentId: string) => qPendingInbox.all(agentId);
export const notifiedBefore = (subscriberId: string, aboutId: string) =>
  (qNotifiedBefore.get(subscriberId, aboutId)?.n ?? 0) > 0;
export const agentsWithPendingInbox = () => qAgentsWithPending.all().map((r) => r.agent_id);

// ── handles ─────────────────────────────────────────────────────────────────

export interface HandleRow {
  agent_id: string;
  run_id: string;
  state: "pending" | "settled";
  outcome: string | null;
  result_ref: string | null;
  settled_at: number | null;
}

const qHandle = db.query<HandleRow, [string]>(`SELECT * FROM handles WHERE agent_id = ?`);

export function getHandle(agentId: string): HandleRow | null {
  return qHandle.get(agentId) ?? null;
}

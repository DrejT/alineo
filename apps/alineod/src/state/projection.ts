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
      spawn_budget, max_agents_budget, created_at)
   VALUES ($agentId, $runId, $parentAgentId, $depth, $spawnIndex, 'provisioning', $specName, $specJson, $sandboxId,
      $spawnBudget, $maxAgentsBudget, $createdAt)
   ON CONFLICT(agent_id) DO NOTHING`,
);

const setAgentState = db.query(
  `UPDATE agents SET state = $state WHERE agent_id = $agentId`,
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
    case "agent_spawned": {
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
        $createdAt: row.ts,
      });
      upsertHandlePending.run({ $agentId: row.agent_id, $runId: row.run_id });
      break;
    }
    case "agent_state_changed":
      setAgentState.run({ $agentId: row.agent_id, $state: p.to as string });
      break;
    case "agent_provisioned":
      setAgentSandbox.run({ $agentId: row.agent_id, $sandboxId: p.sandboxId as string });
      break;
    case "handle_settled":
      settleHandleRow.run({
        $agentId: row.agent_id,
        $outcome: (p.outcome as string) ?? null,
        $resultRef: (p.resultRef as string | null) ?? null,
        $settledAt: row.ts,
      });
      break;
    case "agent_ended":
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
  db.exec("DELETE FROM agents; DELETE FROM handles;");
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
});

interface AgentRow {
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
  created_at: number;
  ended_at: number | null;
  outcome: string | null;
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

export function runAsOf(runId: string): number {
  return qMaxSeq.get(runId)?.m ?? 0;
}

export function liveAgents(): AgentRow[] {
  const live = new Set(["provisioning", "running", "spawning", "paused"]);
  return qAgentsByState.all().filter((r) => live.has(r.state));
}

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

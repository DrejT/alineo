/**
 * Reusable invariant checks for the fault harness (durability-roadmap M0.3 — "0.3 is the
 * backbone, every later chunk adds a scenario to it"). A scenario asserts against these
 * directly, by name, so a failure says which invariant broke, not just "something's wrong".
 *
 * Start small: the two invariants below are the ones the harness's first scenario (kill-9,
 * ../fault-harness.test.ts) actually needs. Later scenarios (tree-consistency.md's
 * concurrency-storm, admission-control.md's admission-storm, agent-supervision.md's
 * chronic-failure) add their own invariant checks here as they land, rather than each inventing
 * a separate ad hoc assertion style.
 */
import { db } from "../../src/state/db";
import { rebuild } from "../../src/state/projection";

interface Snapshot {
  agents: unknown[];
  handles: unknown[];
}

function snapshotProjections(): Snapshot {
  return {
    agents: db.query("SELECT * FROM agents ORDER BY agent_id").all(),
    handles: db.query("SELECT * FROM handles ORDER BY agent_id").all(),
  };
}

/**
 * Invariant (tree-consistency.md #2): the `agents`/`handles` projections always equal a fresh
 * refold of the ledger. Takes a snapshot, forces a full `rebuild()`, and diffs — a real divergence
 * here means some code path mutated a projection without going through `emit()`.
 */
export function assertProjectionMatchesLedgerReplay(): void {
  const before = snapshotProjections();
  rebuild();
  const after = snapshotProjections();
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson !== afterJson) {
    throw new Error(
      `projection does not match a fresh ledger replay.\nbefore: ${beforeJson}\nafter:  ${afterJson}`,
    );
  }
}

interface AgentEndedRow {
  agent_id: string;
  ended_at: number | null;
}
interface HandleRow {
  agent_id: string;
  state: string;
}

/**
 * Invariant: every agent with a recorded end (`ended_at` set — done/failed/aborted/lost/
 * budget-exceeded) has a SETTLED handle. A pending handle on a terminal agent means an
 * `agent.ended` path forgot to settle it — a `waitFor`/`await` on that agent would then hang
 * forever even though the agent is genuinely finished.
 */
export function assertNoOrphanedPendingHandles(): void {
  const ended = db
    .query<AgentEndedRow, []>("SELECT agent_id, ended_at FROM agents WHERE ended_at IS NOT NULL")
    .all();
  const handles = new Map(
    db
      .query<HandleRow, []>("SELECT agent_id, state FROM handles")
      .all()
      .map((h) => [h.agent_id, h.state]),
  );
  const orphaned = ended.filter((a) => handles.get(a.agent_id) !== "settled");
  if (orphaned.length > 0) {
    throw new Error(
      `${orphaned.length} ended agent(s) have a non-settled handle: ${orphaned.map((a) => a.agent_id).join(", ")}`,
    );
  }
}

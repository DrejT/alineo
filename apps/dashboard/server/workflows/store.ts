/**
 * Workflow run registry — bookkeeping `@alineo-labs/workflow` itself doesn't have (confirmed:
 * `WorkflowResult` is just `{stdout, vars}`, nothing persisted). Own tables in the dashboard
 * server's own database, direct SQL.
 */
import { db } from "../db";

db.exec(`
CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,   -- running | done | failed
  sandbox_id  TEXT,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id      TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  run         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  started_at  INTEGER,
  ended_at    INTEGER,
  exit_code   INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  PRIMARY KEY (run_id, step_index)
);
`);

export interface WorkflowRunRow {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  sandbox_id: string | null;
  created_at: number;
  ended_at: number | null;
  error: string | null;
}

export interface WorkflowStepRow {
  run_id: string;
  step_index: number;
  name: string;
  run: string;
  status: "pending" | "running" | "done" | "failed";
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
}

const insertRun = db.query<unknown, [string, string, number]>(
  `INSERT INTO workflow_runs (id, name, status, created_at) VALUES (?, ?, 'running', ?)`,
);
const insertStep = db.query<unknown, [string, number, string, string]>(
  `INSERT INTO workflow_steps (run_id, step_index, name, run) VALUES (?, ?, ?, ?)`,
);
const updateRunStatus = db.query<unknown, [string, string | null, number | null, string]>(
  `UPDATE workflow_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?`,
);
const updateRunSandbox = db.query<unknown, [string, string]>(
  `UPDATE workflow_runs SET sandbox_id = ? WHERE id = ?`,
);
const updateStep = db.query<
  unknown,
  [
    string,
    number | null,
    number | null,
    string | null,
    string | null,
    number | null,
    string,
    number,
  ]
>(
  `UPDATE workflow_steps SET status = ?, exit_code = ?, started_at = COALESCE(started_at, ?),
     stdout = ?, stderr = ?, ended_at = ?
   WHERE run_id = ? AND step_index = ?`,
);

export function createWorkflowRun(
  id: string,
  name: string,
  steps: { name: string; run: string }[],
): void {
  insertRun.run(id, name, Date.now());
  steps.forEach((s, i) => insertStep.run(id, i, s.name, s.run));
}

export function setWorkflowSandbox(id: string, sandboxId: string): void {
  updateRunSandbox.run(sandboxId, id);
}

export function finishWorkflowRun(id: string, status: "done" | "failed", error?: string): void {
  updateRunStatus.run(status, error ?? null, Date.now(), id);
}

const markStepRunning = db.query<unknown, [number, string, number]>(
  `UPDATE workflow_steps SET status = 'running', started_at = ? WHERE run_id = ? AND step_index = ?`,
);

export function startStep(runId: string, index: number): void {
  markStepRunning.run(Date.now(), runId, index);
}

export function finishStep(
  runId: string,
  index: number,
  status: "done" | "failed",
  exitCode: number | null,
  stdout: string,
  stderr: string,
): void {
  updateStep.run(status, exitCode, Date.now(), stdout, stderr, Date.now(), runId, index);
}

const qRun = db.query<WorkflowRunRow, [string]>(`SELECT * FROM workflow_runs WHERE id = ?`);
const qSteps = db.query<WorkflowStepRow, [string]>(
  `SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index ASC`,
);
const qAllRuns = db.query<WorkflowRunRow, []>(
  `SELECT * FROM workflow_runs ORDER BY created_at DESC`,
);

export function getWorkflowRun(id: string): WorkflowRunRow | null {
  return qRun.get(id) ?? null;
}

export function getWorkflowSteps(id: string): WorkflowStepRow[] {
  return qSteps.all(id);
}

export function listWorkflowRuns(): WorkflowRunRow[] {
  return qAllRuns.all();
}

/**
 * Remembers the resource spec a sandbox was created with — needed to reconnect it with fork
 * support after an alineod restart. `SandboxDetails` (the SDK ledger's own view) doesn't carry
 * resources at all, and `Sandbox.connect()` only wires up `.fork()` when `resources` is passed
 * explicitly (it does no ledger lookup of its own — see its doc comment), so without this a
 * sandbox created in an earlier alineod process lifetime would silently lose fork support the
 * moment the process restarts. Own table, non-ledger bookkeeping — same posture as
 * `workflow_runs`/`supervision_counters`.
 */
import { db } from "./db";

db.exec(`
CREATE TABLE IF NOT EXISTS sandbox_resources (
  sandbox_id TEXT PRIMARY KEY,
  cpu        TEXT NOT NULL,
  memory     TEXT NOT NULL,
  gpu        TEXT
);
`);

const insert = db.query<unknown, [string, string, string, string | null]>(
  `INSERT INTO sandbox_resources (sandbox_id, cpu, memory, gpu) VALUES (?, ?, ?, ?)
   ON CONFLICT(sandbox_id) DO NOTHING`,
);
const select = db.query<{ cpu: string; memory: string; gpu: string | null }, [string]>(
  `SELECT cpu, memory, gpu FROM sandbox_resources WHERE sandbox_id = ?`,
);

export function rememberResources(
  sandboxId: string,
  resources: { cpu: string; memory: string; gpu?: string },
): void {
  insert.run(sandboxId, resources.cpu, resources.memory, resources.gpu ?? null);
}

export function recallResources(
  sandboxId: string,
): { cpu: string; memory: string; gpu?: string } | null {
  const row = select.get(sandboxId);
  if (!row) return null;
  return { cpu: row.cpu, memory: row.memory, gpu: row.gpu ?? undefined };
}

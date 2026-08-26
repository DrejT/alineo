import postgres from "postgres";
import type {
  IStorageAdapter,
  LedgerEntry,
  LedgerEvent,
  SandboxDetails,
  ListSandboxOptions,
  EnvironmentRecord,
  CheckpointInfo,
} from "@alineo-labs/core";
import { SandboxStatus } from "@alineo-labs/core";
import { MIGRATION_SQL } from "./migrations";

type Row = {
  sandbox_id: string;
  name: string;
  step_idx: number;
  branch: number | null;
  event: string;
  payload: unknown;
  error: string | null;
  ts: string;
};

type AggRow = {
  name: string;
  sandbox_id: string;
  started_at: string | null;
  completed_at: string | null;
  is_closed: string;
  exec_count: string;
  run_id: string | null;
  resource_id: string | null;
  parent_sandbox_id: string | null;
};

function aggRowToDetails(row: AggRow): SandboxDetails {
  return {
    name: row.name,
    sandboxId: row.sandbox_id,
    status: Number(row.is_closed) ? SandboxStatus.Completed : SandboxStatus.Running,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    execCount: Number(row.exec_count),
    // Older ledger rows written before this field existed have no runId recorded at
    // all — fall back to the sandboxId itself so every session still has *some*
    // stable, unique identity rather than an empty string.
    runId: row.run_id ?? row.sandbox_id,
    resourceId: row.resource_id ?? undefined,
    parentSandboxId: row.parent_sandbox_id ?? undefined,
  };
}

function applyOpts(details: SandboxDetails[], opts?: ListSandboxOptions): SandboxDetails[] {
  let result = details;
  if (opts?.before != null) {
    const before = opts.before;
    result = result.filter((d) => d.startedAt < before);
  }
  if (opts?.status != null) result = result.filter((d) => d.status === opts.status);
  if (opts?.runId != null) result = result.filter((d) => d.runId === opts.runId);
  if (opts?.resourceId != null) result = result.filter((d) => d.resourceId === opts.resourceId);
  if (opts?.limit != null) result = result.slice(0, opts.limit);
  return result;
}

function rowToEntry(row: Row): LedgerEntry {
  return {
    sandboxId: row.sandbox_id,
    name: row.name,
    stepIndex: row.step_idx,
    branch: row.branch ?? undefined,
    event: row.event as LedgerEvent,
    payload: row.payload ?? undefined,
    error: row.error ?? undefined,
    ts: Number(row.ts),
  };
}

export class PostgresAdapter implements IStorageAdapter {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString);
  }

  async connect(): Promise<void> {
    await this.sql.unsafe(MIGRATION_SQL);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async append(entry: LedgerEntry): Promise<void> {
    await this.sql`
      INSERT INTO alineo_events (sandbox_id, name, step_idx, branch, event, payload, error, ts)
      VALUES (
        ${entry.sandboxId},
        ${entry.name},
        ${entry.stepIndex},
        ${entry.branch ?? null},
        ${entry.event},
        ${entry.payload !== undefined ? JSON.stringify(entry.payload) : null},
        ${entry.error ?? null},
        ${entry.ts}
      )
    `;
  }

  async readAll(name: string, sandboxId: string): Promise<LedgerEntry[]> {
    const rows = await this.sql<Row[]>`
      SELECT sandbox_id, name, step_idx, branch, event, payload, error, ts
      FROM alineo_events
      WHERE name = ${name} AND sandbox_id = ${sandboxId}
      ORDER BY ts ASC
    `;
    return rows.map(rowToEntry);
  }

  async lastCheckpoint(name: string, sandboxId: string): Promise<LedgerEntry | null> {
    const rows = await this.sql<Row[]>`
      SELECT sandbox_id, name, step_idx, branch, event, payload, error, ts
      FROM alineo_events
      WHERE name = ${name} AND sandbox_id = ${sandboxId} AND event = 'checkpoint_created'
      ORDER BY ts DESC
      LIMIT 1
    `;
    return rows.length ? rowToEntry(rows[0]) : null;
  }

  private async _aggQuery(whereClause: string, params: string[]): Promise<AggRow[]> {
    return this.sql.unsafe<AggRow[]>(
      `WITH agg AS (
        SELECT
          name,
          sandbox_id,
          MIN(CASE WHEN event = 'sandbox_created' THEN ts END) AS started_at,
          MAX(CASE WHEN event = 'sandbox_closed'  THEN ts END) AS completed_at,
          MAX(CASE WHEN event = 'sandbox_closed'  THEN 1 ELSE 0 END)::int AS is_closed,
          COUNT(CASE WHEN event = 'exec_complete' THEN 1 END)::int AS exec_count,
          MAX(CASE WHEN event = 'sandbox_created' THEN payload->>'runId' END) AS run_id,
          MAX(CASE WHEN event = 'sandbox_created' THEN payload->>'resourceId' END) AS resource_id,
          MAX(CASE WHEN event = 'sandbox_created' THEN payload->>'parentSandboxId' END) AS parent_sandbox_id
        FROM alineo_events
        ${whereClause}
        GROUP BY name, sandbox_id
      )
      SELECT * FROM agg WHERE started_at IS NOT NULL ORDER BY started_at DESC`,
      params,
    );
  }

  async listSandboxDetails(name: string, opts?: ListSandboxOptions): Promise<SandboxDetails[]> {
    const rows = await this._aggQuery("WHERE name = $1", [name]);
    return applyOpts(rows.map(aggRowToDetails), opts);
  }

  async listAllSandboxDetails(opts?: ListSandboxOptions): Promise<SandboxDetails[]> {
    const rows = await this._aggQuery("", []);
    return applyOpts(rows.map(aggRowToDetails), opts);
  }

  async getSandboxDetails(name: string, sandboxId: string): Promise<SandboxDetails | null> {
    const rows = await this._aggQuery("WHERE name = $1 AND sandbox_id = $2", [name, sandboxId]);
    return rows.length ? aggRowToDetails(rows[0]) : null;
  }

  async deleteSandbox(name: string, sandboxId: string): Promise<void> {
    await this.sql`DELETE FROM alineo_events WHERE name = ${name} AND sandbox_id = ${sandboxId}`;
  }

  async listCheckpoints(name: string, sandboxId: string): Promise<CheckpointInfo[]> {
    const rows = await this.sql<Row[]>`
      SELECT sandbox_id, name, step_idx, branch, event, payload, error, ts
      FROM alineo_events
      WHERE name = ${name} AND sandbox_id = ${sandboxId} AND event = 'checkpoint_created'
      ORDER BY ts ASC
    `;
    return rows.map((r) => {
      const p = (r.payload ?? {}) as { snapshotId: string; name?: string };
      return { snapshotId: p.snapshotId, tag: p.name, createdAt: Number(r.ts) };
    });
  }

  async getEnvironment(name: string): Promise<EnvironmentRecord | null> {
    const rows = await this.sql<
      { name: string; snapshot_id: string; image: string; built_at: string }[]
    >`
      SELECT name, snapshot_id, image, built_at FROM alineo_environments WHERE name = ${name}
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return { name: r.name, snapshotId: r.snapshot_id, image: r.image, builtAt: Number(r.built_at) };
  }

  async saveEnvironment(record: EnvironmentRecord): Promise<void> {
    await this.sql`
      INSERT INTO alineo_environments (name, snapshot_id, image, built_at)
      VALUES (${record.name}, ${record.snapshotId}, ${record.image}, ${record.builtAt})
      ON CONFLICT (name) DO UPDATE
        SET snapshot_id = excluded.snapshot_id,
            image       = excluded.image,
            built_at    = excluded.built_at
    `;
  }

  async deleteEnvironment(name: string): Promise<void> {
    await this.sql`DELETE FROM alineo_environments WHERE name = ${name}`;
  }

  async listEnvironments(): Promise<EnvironmentRecord[]> {
    const rows = await this.sql<
      { name: string; snapshot_id: string; image: string; built_at: string }[]
    >`
      SELECT name, snapshot_id, image, built_at FROM alineo_environments ORDER BY built_at DESC
    `;
    return rows.map((r) => ({
      name: r.name,
      snapshotId: r.snapshot_id,
      image: r.image,
      builtAt: Number(r.built_at),
    }));
  }
}

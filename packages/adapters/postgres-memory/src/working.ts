import type { IWorkingMemoryProvider, ResourceRef } from "@alineo-labs/memory";
import { scopeKey } from "@alineo-labs/memory";
import { PostgresMemoryConnection } from "./shared";

/**
 * Persisted, multi-process-safe `IWorkingMemoryProvider` backed by Postgres — the shared,
 * production-shaped counterpart to `@alineo-labs/sqlite-memory`'s file-based provider. Rows
 * are additionally isolated by `ResourceRef.teamId` via row-level security (see
 * `migrations.ts`) whenever a team is set.
 *
 * Written against the `postgres` package the same way `@alineo-labs/postgres`'s ledger
 * adapter is, but — like that adapter — has no live database to run against in this repo's
 * test environment, so this ships type-checked, not integration-tested against a real
 * Postgres instance.
 */
export class PostgresWorkingMemoryProvider implements IWorkingMemoryProvider {
  private readonly conn: PostgresMemoryConnection;

  constructor(connectionString: string) {
    this.conn = new PostgresMemoryConnection(connectionString);
  }

  async get(ref: ResourceRef, key: string): Promise<unknown | undefined> {
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) =>
        tx<{ value: unknown }[]>`
          SELECT value FROM alineo_working_memory WHERE scope = ${scopeKey(ref)} AND key = ${key}
        `,
    );
    return rows.length ? rows[0]!.value : undefined;
  }

  async set(ref: ResourceRef, key: string, value: unknown): Promise<void> {
    await this.conn.withTeamContext(
      ref,
      (tx) => tx`
        INSERT INTO alineo_working_memory (scope, team_id, key, value)
        VALUES (${scopeKey(ref)}, ${ref.teamId ?? null}, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value
      `,
    );
  }

  async list(ref: ResourceRef): Promise<Record<string, unknown>> {
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) =>
        tx<{ key: string; value: unknown }[]>`
          SELECT key, value FROM alineo_working_memory WHERE scope = ${scopeKey(ref)}
        `,
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async delete(ref: ResourceRef, key: string): Promise<void> {
    await this.conn.withTeamContext(
      ref,
      (tx) => tx`
        DELETE FROM alineo_working_memory WHERE scope = ${scopeKey(ref)} AND key = ${key}
      `,
    );
  }

  /** Release the underlying connection pool. */
  async close(): Promise<void> {
    await this.conn.close();
  }
}

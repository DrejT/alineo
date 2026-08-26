import postgres from "postgres";
import type { ResourceRef } from "@alineo-labs/memory";
import { MIGRATION_SQL } from "./migrations";

/**
 * Lazily runs migrations on first use, memoized — same pattern `Sandbox._ensureConnected()`
 * uses in `@alineo-labs/sandbox` — so callers don't need to remember an explicit `connect()`
 * step before their first query.
 */
export class PostgresMemoryConnection {
  readonly sql: ReturnType<typeof postgres>;
  private migratePromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString);
  }

  private ensureMigrated(): Promise<void> {
    this.migratePromise ??= this.sql.unsafe(MIGRATION_SQL).then(() => undefined);
    return this.migratePromise;
  }

  /**
   * Runs `fn` inside a transaction that first sets `app.team_id` for the duration of that
   * transaction (`SET LOCAL`, via `set_config(..., true)`) whenever `ref.teamId` is set — the
   * mechanism the RLS policies in `migrations.ts` check against. A `ref` with no `teamId`
   * skips the `set_config` call entirely; rows with `team_id IS NULL` are visible regardless.
   */
  async withTeamContext<T>(
    ref: ResourceRef,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    await this.ensureMigrated();
    // `sql.begin()`'s own generic inference doesn't round-trip a caller-supplied `T` cleanly
    // (a `postgres` package typings quirk, not a logic issue) — the explicit cast reflects
    // what's actually true at runtime: this resolves to exactly what `fn` returned.
    const result = await this.sql.begin(async (tx) => {
      if (ref.teamId) {
        await tx`SELECT set_config('app.team_id', ${ref.teamId}, true)`;
      }
      return fn(tx);
    });
    return result as T;
  }

  /** Release the underlying connection pool. */
  async close(): Promise<void> {
    await this.sql.end();
  }
}

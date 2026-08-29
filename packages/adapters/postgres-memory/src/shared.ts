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
  private pgvectorPromise: Promise<boolean> | null = null;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString);
  }

  private ensureMigrated(): Promise<void> {
    // Clear the cached promise on rejection — otherwise a transient DB blip on the very first
    // call poisons this instance for the rest of the process lifetime: `??=` would keep
    // returning the same rejected promise to every later get/set/list/delete/remember/recall,
    // even after Postgres recovers, with no way to clear it short of a restart.
    this.migratePromise ??= this.sql.unsafe(MIGRATION_SQL).then(
      () => undefined,
      (err) => {
        this.migratePromise = null;
        throw err;
      },
    );
    return this.migratePromise;
  }

  /**
   * Best-effort `CREATE EXTENSION IF NOT EXISTS vector`, memoized. Deliberately kept separate
   * from `ensureMigrated()` above: the base schema (working memory, semantic memory, RLS) must
   * succeed on any Postgres instance, including managed ones where the connecting role isn't
   * allowed to create extensions at all or where `pgvector` isn't installed — this call is
   * allowed to fail without taking the rest of the package down with it.
   *
   * Unlike `ensureMigrated()`, this never rejects and is memoized permanently once resolved —
   * a `false` result (extension missing, or no privilege) means "use the in-JS cosine-scan
   * fallback for the rest of this process," which is a correctness-preserving, merely-slower
   * degradation, not a broken instance. That also means a *transient* failure here (e.g. a
   * connection blip on the very first call) is indistinguishable from a permanent one and
   * pins this connection to the fallback path for its whole lifetime — an accepted trade-off,
   * not an oversight: retrying this on every call would mean every `remember()`/`recall()`
   * pays for a fresh `CREATE EXTENSION` attempt against a Postgres instance that may never
   * grant it, which is worse than staying on the always-correct fallback.
   */
  async ensurePgvectorExtension(): Promise<boolean> {
    if (!this.pgvectorPromise) {
      this.pgvectorPromise = this.ensureMigrated()
        .then(() => this.sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector"))
        .then(
          () => true,
          () => false,
        );
    }
    return this.pgvectorPromise;
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

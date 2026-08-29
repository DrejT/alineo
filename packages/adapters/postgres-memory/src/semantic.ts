import type {
  EmbeddingProvider,
  IBulkSemanticMemoryProvider,
  IPrunableSemanticMemoryProvider,
  MemoryFact,
  RememberedFact,
  ResourceRef,
} from "@alineo-labs/memory";
import { cosineSimilarity, factFromRow, scopeKey } from "@alineo-labs/memory";
import { PostgresMemoryConnection } from "./shared";

type Row = {
  id: string;
  content: string;
  vector: number[];
  source_sandbox_id: string | null;
  source_entry_index: number | null;
  remembered_at: string;
};

/** `remembered_at` comes back from Postgres's `BIGINT` column as a numeric string, unlike
 *  `@alineo-labs/sqlite-memory`'s `number` — coerce before handing off to the shared mapping. */
function toSharedRow(row: Row) {
  return { ...row, remembered_at: Number(row.remembered_at) };
}

/** Encodes a raw embedding as the text literal `pgvector` accepts via an explicit `::vector`
 *  cast — the `postgres` driver has no native binary type for it, so a plain interpolated
 *  string plus a SQL-side cast is the standard way to pass one through this driver. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

const VEC_TABLE = "alineo_semantic_vec";

/**
 * Persisted, multi-process-safe `ISemanticMemoryProvider` (+ pruning) backed by Postgres.
 *
 * Ranks `recall()` with a real `pgvector` HNSW index whenever the `vector` extension can be
 * installed on the connected Postgres instance (`CREATE EXTENSION IF NOT EXISTS vector` —
 * enabled by default on Supabase/Neon/RDS-with-the-extension-allowlisted; unavailable on a
 * bare Postgres with no superuser access), falling back to the same in-JS cosine-similarity
 * scan `InMemorySemanticMemoryProvider`/`SQLiteSemanticMemoryProvider`'s no-index path uses
 * otherwise. `hasVectorIndex` reports which path is active — mirrors
 * `SQLiteSemanticMemoryProvider`'s own `hasVectorIndex`/`vecAvailable` split exactly.
 *
 * The plain `vector` (`double precision[]`) column on `alineo_semantic_memory` is always
 * populated regardless of which path is active, so the fallback is never a degraded schema —
 * it's a genuinely lower-performance code path over the same data, same as the SQLite adapter.
 * The indexed path additionally maintains a separate `alineo_semantic_vec` table (id, scope,
 * team_id, a real `vector(N)` column + HNSW index), created lazily once the embedding
 * dimension is known from the first fact remembered — an `ON DELETE CASCADE` foreign key back
 * to `alineo_semantic_memory.id` keeps it in sync with `forget()` for free, no extra delete
 * needed there. Both tables get identical row-level-security policies, so scoping doesn't
 * depend on which path a given `recall()` call takes.
 *
 * Unlike `SQLiteSemanticMemoryProvider`'s `vec0` virtual table (which needs `scope` declared
 * as a native *partition key* so vec0's own KNN traversal applies it before counting `k`
 * neighbors — see that file's `ensureVecTable` comment), a plain `WHERE v.scope = ...` alongside
 * `ORDER BY ... LIMIT k` is sufficient and correct here: Postgres's planner evaluates the filter
 * as part of the same query regardless of whether it uses the HNSW index or falls back to a
 * sequential scan, so a resource never receives fewer than `k` matching rows the way an
 * outer-join-after-KNN approach could.
 *
 * Mixing embedding models with different output dimensions on one instance throws a real
 * Postgres dimension-mismatch error at insert time once `alineo_semantic_vec` is sized to the
 * first dimension seen — same documented behavior as the SQLite adapter, not silently wrong.
 *
 * Like `PostgresWorkingMemoryProvider`, this ships type-checked against no live database.
 */
export class PostgresSemanticMemoryProvider
  implements IPrunableSemanticMemoryProvider, IBulkSemanticMemoryProvider
{
  private readonly conn: PostgresMemoryConnection;
  private vecDimensions: number | null = null;
  private ensureVecTablePromise: Promise<void> | null = null;

  constructor(
    connectionString: string,
    private readonly embeddings: EmbeddingProvider,
  ) {
    this.conn = new PostgresMemoryConnection(connectionString);
  }

  /** Whether `recall()` is using the native `pgvector` HNSW index (true) or the in-JS cosine
   *  fallback scan (false, either because the extension isn't available on this Postgres
   *  instance or no fact has been remembered yet to size the index from). */
  get hasVectorIndex(): boolean {
    return this.vecDimensions != null;
  }

  /** Lazily creates `alineo_semantic_vec`, sized to `dimensions` — memoized, and (like
   *  `PostgresMemoryConnection.ensureMigrated()`) cleared on rejection so a transient failure
   *  here doesn't permanently pin this instance to the fallback path the way a permanent one
   *  reasonably should. */
  private ensureVecTable(dimensions: number): Promise<void> {
    if (this.vecDimensions === dimensions) return Promise.resolve();
    this.ensureVecTablePromise ??= this.conn.sql
      .unsafe(
        `
        CREATE TABLE IF NOT EXISTS ${VEC_TABLE} (
          id        TEXT   PRIMARY KEY REFERENCES alineo_semantic_memory(id) ON DELETE CASCADE,
          scope     TEXT   NOT NULL,
          team_id   TEXT,
          embedding VECTOR(${dimensions}) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${VEC_TABLE}_hnsw ON ${VEC_TABLE}
          USING hnsw (embedding vector_cosine_ops);
        ALTER TABLE ${VEC_TABLE} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${VEC_TABLE} FORCE ROW LEVEL SECURITY;
        DO $$ BEGIN
          CREATE POLICY ${VEC_TABLE}_team_isolation ON ${VEC_TABLE}
            FOR ALL
            USING (team_id IS NULL OR team_id = current_setting('app.team_id', true))
            WITH CHECK (team_id IS NULL OR team_id = current_setting('app.team_id', true));
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `,
      )
      .then(
        () => {
          this.vecDimensions = dimensions;
        },
        (err) => {
          this.ensureVecTablePromise = null;
          throw err;
        },
      );
    return this.ensureVecTablePromise;
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content], { type: "passage" });
    if (!vector) return;
    const usePgvector = await this.conn.ensurePgvectorExtension();
    if (usePgvector) await this.ensureVecTable(vector.length);

    const id = crypto.randomUUID();
    // Both inserts share one transaction: if the vec-table insert fails after the metadata
    // insert already succeeded, the fact must not silently become unreachable via recall() —
    // once `hasVectorIndex` is true, recall() only queries `alineo_semantic_vec`, so an orphaned
    // metadata-only row would never surface again through the indexed path.
    await this.conn.withTeamContext(ref, async (tx) => {
      await tx`
        INSERT INTO alineo_semantic_memory
          (id, scope, team_id, content, vector, source_sandbox_id, source_entry_index, remembered_at)
        VALUES (
          ${id},
          ${scopeKey(ref)},
          ${ref.teamId ?? null},
          ${fact.content},
          ${tx.array(vector)},
          ${fact.sourceRef?.sandboxId ?? null},
          ${fact.sourceRef?.entryIndex ?? null},
          ${Date.now()}
        )
      `;
      if (usePgvector && this.hasVectorIndex) {
        await tx`
          INSERT INTO alineo_semantic_vec (id, scope, team_id, embedding)
          VALUES (${id}, ${scopeKey(ref)}, ${ref.teamId ?? null}, ${toVectorLiteral(vector)}::vector)
        `;
      }
    });
  }

  /** Batches the embedding call for all `facts` into one `embed()` invocation, and runs every
   *  insert (both tables, when the vec index is active) inside the single transaction
   *  `withTeamContext` already opens, instead of one transaction per fact — see
   *  `IBulkSemanticMemoryProvider`. */
  async rememberMany(ref: ResourceRef, facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    const vectors = await this.embeddings.embed(
      facts.map((f) => f.content),
      { type: "passage" },
    );

    const usePgvector = await this.conn.ensurePgvectorExtension();
    if (usePgvector) {
      const firstVector = vectors.find((v): v is number[] => v != null);
      if (firstVector) await this.ensureVecTable(firstVector.length);
    }

    await this.conn.withTeamContext(ref, async (tx) => {
      for (let i = 0; i < facts.length; i++) {
        const vector = vectors[i];
        const fact = facts[i]!;
        if (!vector) continue;
        const id = crypto.randomUUID();
        await tx`
          INSERT INTO alineo_semantic_memory
            (id, scope, team_id, content, vector, source_sandbox_id, source_entry_index, remembered_at)
          VALUES (
            ${id},
            ${scopeKey(ref)},
            ${ref.teamId ?? null},
            ${fact.content},
            ${tx.array(vector)},
            ${fact.sourceRef?.sandboxId ?? null},
            ${fact.sourceRef?.entryIndex ?? null},
            ${Date.now()}
          )
        `;
        if (usePgvector && this.hasVectorIndex) {
          await tx`
            INSERT INTO alineo_semantic_vec (id, scope, team_id, embedding)
            VALUES (${id}, ${scopeKey(ref)}, ${ref.teamId ?? null}, ${toVectorLiteral(vector)}::vector)
          `;
        }
      }
    });
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const topK = opts.topK ?? 5;
    const [queryVector] = await this.embeddings.embed([query], { type: "query" });
    if (!queryVector) return [];

    if (this.hasVectorIndex) {
      const rows = await this.conn.withTeamContext(
        ref,
        (tx) => tx<Row[]>`
          SELECT m.id, m.content, m.source_sandbox_id, m.source_entry_index, m.remembered_at
          FROM ${tx(VEC_TABLE)} v
          JOIN alineo_semantic_memory m ON m.id = v.id
          WHERE v.scope = ${scopeKey(ref)}
          ORDER BY v.embedding <=> ${toVectorLiteral(queryVector)}::vector
          LIMIT ${topK}
        `,
      );
      return rows.map((row) => factFromRow(toSharedRow(row)));
    }

    // Fallback: in-JS cosine scan over every row for the resource, same as
    // `InMemorySemanticMemoryProvider`/`SQLiteSemanticMemoryProvider`'s no-index path.
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) => tx<Row[]>`SELECT * FROM alineo_semantic_memory WHERE scope = ${scopeKey(ref)}`,
    );
    if (rows.length === 0) return [];
    return rows
      .map((row) => ({ row, score: cosineSimilarity(queryVector, row.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row }) => factFromRow(toSharedRow(row)));
  }

  async listAll(ref: ResourceRef): Promise<RememberedFact[]> {
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) => tx<Row[]>`SELECT * FROM alineo_semantic_memory WHERE scope = ${scopeKey(ref)}`,
    );
    return rows.map((row) => factFromRow(toSharedRow(row)));
  }

  async forget(ref: ResourceRef, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.conn.withTeamContext(
      ref,
      (tx) => tx`
        DELETE FROM alineo_semantic_memory WHERE scope = ${scopeKey(ref)} AND id IN ${tx(ids)}
      `,
    );
    return result.count;
  }

  /** Release the underlying connection pool. */
  async close(): Promise<void> {
    await this.conn.close();
  }
}

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

/**
 * Persisted, multi-process-safe `ISemanticMemoryProvider` (+ pruning) backed by Postgres.
 * Ranking is an in-JS cosine-similarity scan over every row for the resource — the vector
 * column is a plain `double precision[]` array, not a `pgvector` column, so this works against
 * any Postgres instance with zero extensions, at the cost of no real ANN index. A deployment
 * that needs indexed vector search at real scale should add the `pgvector` extension, change
 * the `vector` column to `vector(N)`, and replace `recall()`'s scan with an
 * `ORDER BY vector <=> query_vector LIMIT k` query — everything else in this file (scoping,
 * RLS, pruning) stays the same.
 *
 * Like `PostgresWorkingMemoryProvider`, this ships type-checked against no live database.
 */
export class PostgresSemanticMemoryProvider
  implements IPrunableSemanticMemoryProvider, IBulkSemanticMemoryProvider
{
  private readonly conn: PostgresMemoryConnection;

  constructor(
    connectionString: string,
    private readonly embeddings: EmbeddingProvider,
  ) {
    this.conn = new PostgresMemoryConnection(connectionString);
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content], { type: "passage" });
    if (!vector) return;
    await this.conn.withTeamContext(
      ref,
      (tx) => tx`
        INSERT INTO alineo_semantic_memory
          (id, scope, team_id, content, vector, source_sandbox_id, source_entry_index, remembered_at)
        VALUES (
          ${crypto.randomUUID()},
          ${scopeKey(ref)},
          ${ref.teamId ?? null},
          ${fact.content},
          ${tx.array(vector)},
          ${fact.sourceRef?.sandboxId ?? null},
          ${fact.sourceRef?.entryIndex ?? null},
          ${Date.now()}
        )
      `,
    );
  }

  /** Batches the embedding call for all `facts` into one `embed()` invocation, and runs every
   *  insert inside the single transaction `withTeamContext` already opens, instead of one
   *  transaction per fact — see `IBulkSemanticMemoryProvider`. */
  async rememberMany(ref: ResourceRef, facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    const vectors = await this.embeddings.embed(
      facts.map((f) => f.content),
      { type: "passage" },
    );
    await this.conn.withTeamContext(ref, async (tx) => {
      for (let i = 0; i < facts.length; i++) {
        const vector = vectors[i];
        const fact = facts[i]!;
        if (!vector) continue;
        await tx`
          INSERT INTO alineo_semantic_memory
            (id, scope, team_id, content, vector, source_sandbox_id, source_entry_index, remembered_at)
          VALUES (
            ${crypto.randomUUID()},
            ${scopeKey(ref)},
            ${ref.teamId ?? null},
            ${fact.content},
            ${tx.array(vector)},
            ${fact.sourceRef?.sandboxId ?? null},
            ${fact.sourceRef?.entryIndex ?? null},
            ${Date.now()}
          )
        `;
      }
    });
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) => tx<Row[]>`SELECT * FROM alineo_semantic_memory WHERE scope = ${scopeKey(ref)}`,
    );
    if (rows.length === 0) return [];

    const [queryVector] = await this.embeddings.embed([query], { type: "query" });
    if (!queryVector) return [];

    const topK = opts.topK ?? 5;
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

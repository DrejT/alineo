import type {
  EmbeddingProvider,
  IPrunableSemanticMemoryProvider,
  MemoryFact,
  RememberedFact,
  ResourceRef,
} from "@alineo-labs/memory";
import { cosineSimilarity, scopeKey } from "@alineo-labs/memory";
import { PostgresMemoryConnection } from "./shared";

type Row = {
  id: string;
  content: string;
  vector: number[];
  source_sandbox_id: string | null;
  source_entry_index: number | null;
  remembered_at: string;
};

function rowToFact(row: Row): RememberedFact {
  return {
    content: row.content,
    sourceRef:
      row.source_sandbox_id != null
        ? { sandboxId: row.source_sandbox_id, entryIndex: row.source_entry_index! }
        : undefined,
    id: row.id,
    rememberedAt: Number(row.remembered_at),
  };
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
export class PostgresSemanticMemoryProvider implements IPrunableSemanticMemoryProvider {
  private readonly conn: PostgresMemoryConnection;

  constructor(
    connectionString: string,
    private readonly embeddings: EmbeddingProvider,
  ) {
    this.conn = new PostgresMemoryConnection(connectionString);
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content]);
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

    const [queryVector] = await this.embeddings.embed([query]);
    if (!queryVector) return [];

    const topK = opts.topK ?? 5;
    return rows
      .map((row) => ({ row, score: cosineSimilarity(queryVector, row.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row }) => rowToFact(row));
  }

  async listAll(ref: ResourceRef): Promise<RememberedFact[]> {
    const rows = await this.conn.withTeamContext(
      ref,
      (tx) => tx<Row[]>`SELECT * FROM alineo_semantic_memory WHERE scope = ${scopeKey(ref)}`,
    );
    return rows.map(rowToFact);
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

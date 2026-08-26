import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EmbeddingProvider,
  IPrunableSemanticMemoryProvider,
  MemoryFact,
  RememberedFact,
  ResourceRef,
} from "@alineo-labs/memory";
import { cosineSimilarity, scopeKey } from "@alineo-labs/memory";
import { SEMANTIC_MEMORY_MIGRATION_SQL } from "./migrations";

type Row = {
  id: string;
  content: string;
  vector: string;
  source_sandbox_id: string | null;
  source_entry_index: number | null;
  remembered_at: number;
};

function rowToFact(row: Row): RememberedFact {
  return {
    content: row.content,
    sourceRef:
      row.source_sandbox_id != null
        ? { sandboxId: row.source_sandbox_id, entryIndex: row.source_entry_index! }
        : undefined,
    id: row.id,
    rememberedAt: row.remembered_at,
  };
}

/**
 * Persisted `ISemanticMemoryProvider` (+ pruning) backed by `bun:sqlite`. Ranking is still an
 * in-JS cosine-similarity scan over every row for the resource, same complexity as
 * `InMemorySemanticMemoryProvider` — `bun:sqlite` has no vector index built in. That's fine at
 * the scale this backend targets (persisted single-file local/dev use); a deployment that
 * needs real ANN search at scale should reach for `@alineo-labs/postgres-memory` with pgvector
 * instead. What persistence buys here is surviving process restarts, not query complexity.
 */
export class SQLiteSemanticMemoryProvider implements IPrunableSemanticMemoryProvider {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly embeddings: EmbeddingProvider,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    this.db = new Database(path, { create: true });
    this.db.exec(SEMANTIC_MEMORY_MIGRATION_SQL);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content]);
    if (!vector) return;
    this.db
      .prepare(
        `INSERT INTO alineo_semantic_memory
           (id, scope, content, vector, source_sandbox_id, source_entry_index, remembered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        scopeKey(ref),
        fact.content,
        JSON.stringify(vector),
        fact.sourceRef?.sandboxId ?? null,
        fact.sourceRef?.entryIndex ?? null,
        Date.now(),
      );
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const rows = this.db
      .prepare<Row, [string]>("SELECT * FROM alineo_semantic_memory WHERE scope = ?")
      .all(scopeKey(ref));
    if (rows.length === 0) return [];

    const [queryVector] = await this.embeddings.embed([query]);
    if (!queryVector) return [];

    const topK = opts.topK ?? 5;
    return rows
      .map((row) => ({ row, score: cosineSimilarity(queryVector, JSON.parse(row.vector)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row }) => rowToFact(row));
  }

  async listAll(ref: ResourceRef): Promise<RememberedFact[]> {
    const rows = this.db
      .prepare<Row, [string]>("SELECT * FROM alineo_semantic_memory WHERE scope = ?")
      .all(scopeKey(ref));
    return rows.map(rowToFact);
  }

  async forget(ref: ResourceRef, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM alineo_semantic_memory WHERE scope = ? AND id IN (${placeholders})`)
      .run(scopeKey(ref), ...ids);
    return result.changes;
  }

  /** Release the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}

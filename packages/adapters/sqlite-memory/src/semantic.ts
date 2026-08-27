import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
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
  rowid_key: number;
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
    // No stored column — derived from source_sandbox_id, same "computed, not caller-set"
    // rule @alineo-labs/memory's own providers follow.
    verified: row.source_sandbox_id != null,
    id: row.id,
    rememberedAt: row.remembered_at,
  };
}

const VEC_TABLE = "alineo_semantic_vec";

/**
 * Persisted `ISemanticMemoryProvider` (+ pruning) backed by `bun:sqlite`.
 *
 * Ranks `recall()` with a real native vector index — the `sqlite-vec` extension's `vec0`
 * virtual table — not a JS-level scan, whenever the extension loads successfully for the
 * current platform (verified working here on win32/x64; `sqlite-vec` ships prebuilt binaries
 * for the common platforms via optional npm deps). The vector index is created lazily, sized
 * to the first embedding's dimension actually seen — every subsequent `remember()` must
 * produce vectors of that same dimension (mixing embedding models with different output sizes
 * on one instance will throw from `sqlite-vec` itself, not silently misbehave).
 *
 * If the extension fails to load (e.g. an unsupported platform, or a sandboxed environment
 * that blocks native extension loading), this falls back to the same in-JS cosine-similarity
 * scan `InMemorySemanticMemoryProvider` uses — slower, but still correct. `hasVectorIndex`
 * reports which path is active. The plain `vector` (JSON) column is always populated
 * regardless, so nothing about the fallback is a degraded schema — it's a genuinely
 * lower-performance code path over the same data.
 */
export class SQLiteSemanticMemoryProvider implements IPrunableSemanticMemoryProvider {
  private readonly db: Database;
  private vecAvailable: boolean;
  private vecDimensions: number | null = null;

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

    try {
      this.db.loadExtension(sqliteVec.getLoadablePath());
      this.vecAvailable = true;
    } catch {
      this.vecAvailable = false;
    }
  }

  /** Whether `recall()` is using the native `sqlite-vec` index (true) or the in-JS cosine
   *  fallback scan (false, either because the extension didn't load or no fact has been
   *  remembered yet to size the index from). */
  get hasVectorIndex(): boolean {
    return this.vecAvailable && this.vecDimensions != null;
  }

  private ensureVecTable(dimensions: number): void {
    if (this.vecDimensions != null) return;
    // `scope` is declared as a partition key, not a plain column: vec0 applies it natively
    // during the KNN traversal itself, before `k` is counted. A plain column filtered via an
    // outer JOIN (tried first, verified wrong) applies AFTER vec0 already picked its global
    // top-`k` nearest neighbors — with multiple resources sharing one table, that silently
    // returns fewer than `k` rows (or the wrong ones) whenever another resource's facts are
    // closer to the query than some of this resource's own facts.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(scope TEXT partition key, embedding float[${dimensions}])`,
    );
    this.vecDimensions = dimensions;
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content]);
    if (!vector) return;

    const result = this.db
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

    if (this.vecAvailable) {
      this.ensureVecTable(vector.length);
      this.db
        .prepare(`INSERT INTO ${VEC_TABLE}(rowid, scope, embedding) VALUES (?, ?, ?)`)
        .run(result.lastInsertRowid, scopeKey(ref), new Float32Array(vector));
    }
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const topK = opts.topK ?? 5;
    const [queryVector] = await this.embeddings.embed([query]);
    if (!queryVector) return [];

    if (this.hasVectorIndex) {
      // The native path: rank via vec0's own KNN (scoped natively through the partition key,
      // not an outer-join filter — see ensureVecTable's comment for why that distinction is
      // load-bearing for correctness), then join back to the metadata table by rowid. No
      // JS-level scoring, no loading every row for the resource into memory.
      const rows = this.db
        .prepare<Row, [Float32Array, string, number]>(`
          SELECT m.rowid_key, m.id, m.content, m.vector, m.source_sandbox_id,
                 m.source_entry_index, m.remembered_at
          FROM ${VEC_TABLE} v
          JOIN alineo_semantic_memory m ON m.rowid_key = v.rowid
          WHERE v.embedding MATCH ? AND v.scope = ? AND k = ?
          ORDER BY v.distance
        `)
        .all(new Float32Array(queryVector), scopeKey(ref), topK);
      return rows.map(rowToFact);
    }

    // Fallback: in-JS cosine scan, same as InMemorySemanticMemoryProvider.
    const rows = this.db
      .prepare<Row, [string]>("SELECT * FROM alineo_semantic_memory WHERE scope = ?")
      .all(scopeKey(ref));
    if (rows.length === 0) return [];
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

    if (this.vecAvailable) {
      this.db
        .prepare(
          `DELETE FROM ${VEC_TABLE} WHERE rowid IN (
             SELECT rowid_key FROM alineo_semantic_memory WHERE scope = ? AND id IN (${placeholders})
           )`,
        )
        .run(scopeKey(ref), ...ids);
    }

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

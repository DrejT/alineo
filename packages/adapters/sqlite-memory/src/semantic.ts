import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import type {
  EmbeddingProvider,
  IBulkSemanticMemoryProvider,
  IPrunableSemanticMemoryProvider,
  IRecentSemanticMemoryProvider,
  MemoryFact,
  RememberedFact,
  ResourceRef,
} from "@alineo-labs/memory";
import { cosineSimilarity, factFromRow, scopeKey } from "@alineo-labs/memory";
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

const VEC_TABLE = "alineo_semantic_vec";

function dimensionMismatch(existing: number, got: number): Error {
  return new Error(
    `semantic memory was built for ${existing}-dimensional embeddings but this embedding model ` +
      `produced ${got}. Vectors from different models are not comparable, so the index can't be ` +
      `shared: point this store at a fresh database file when you change embedding models.`,
  );
}

/**
 * Load the `sqlite-vec` extension into `db`. `false` (not a throw) when it can't load — an
 * unsupported platform, or a host that blocks native extensions — because the provider has a
 * correct JS fallback for that case.
 *
 * Exported so anything else that has to open this provider's database (a backup tool, say: a
 * `vec0` virtual table can't be read, or `VACUUM`ed, without its module) loads the extension the
 * same way the provider does, rather than carrying a second copy of how.
 */
export function loadSqliteVec(db: Database): boolean {
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
    return true;
  } catch {
    return false;
  }
}

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
export class SQLiteSemanticMemoryProvider
  implements
    IPrunableSemanticMemoryProvider,
    IBulkSemanticMemoryProvider,
    IRecentSemanticMemoryProvider
{
  private readonly db: Database;
  private vecAvailable: boolean;
  private vecDimensions: number | null = null;

  constructor(
    path: string,
    private readonly embeddings: EmbeddingProvider,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    this.db = new Database(path, { create: true });
    this.db.exec(SEMANTIC_MEMORY_MIGRATION_SQL);
    this.db.exec("PRAGMA journal_mode = WAL;");

    this.vecAvailable = loadSqliteVec(this.db);
  }

  /** Whether `recall()` is using the native `sqlite-vec` index (true) or the in-JS cosine
   *  fallback scan (false, either because the extension didn't load or no fact has been
   *  remembered yet to size the index from). */
  get hasVectorIndex(): boolean {
    return this.vecAvailable && this.vecDimensions != null;
  }

  /**
   * Make sure the `vec0` index exists and was built for vectors of `dimensions` — and throw,
   * before anything is written, when it was not.
   *
   * `CREATE VIRTUAL TABLE IF NOT EXISTS` is a silent no-op against a table that already exists
   * with a different width, and the dimension this instance tracks in memory starts out null on
   * every process start. So after switching to an embedding model of another size, nothing here
   * would object: the index would be reported as usable (`hasVectorIndex`) and the first insert
   * would fail deep in the native extension, after the fact's metadata row was already written.
   * Compare against the width actually on disk instead, and name the way out.
   */
  private ensureVecTable(dimensions: number): void {
    if (this.vecDimensions != null) {
      if (dimensions !== this.vecDimensions)
        throw dimensionMismatch(this.vecDimensions, dimensions);
      return;
    }
    const existing = this.db
      .prepare<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(VEC_TABLE);
    const onDisk = existing ? /float\[(\d+)\]/.exec(existing.sql)?.[1] : undefined;
    if (onDisk !== undefined && Number(onDisk) !== dimensions) {
      throw dimensionMismatch(Number(onDisk), dimensions);
    }
    // `scope` is declared as a partition key, not a plain column: vec0 applies it natively
    // during the KNN traversal itself, before `k` is counted. A plain column filtered via an
    // outer JOIN (tried first, verified wrong) applies AFTER vec0 already picked its global
    // top-`k` nearest neighbors — with multiple resources sharing one table, that silently
    // returns fewer than `k` rows (or the wrong ones) whenever another resource's facts are
    // closer to the query than some of this resource's own facts.
    //
    // `distance_metric=cosine` is explicit, not sqlite-vec's default (L2/Euclidean) — without
    // it, this backend would rank recall() differently than `PostgresSemanticMemoryProvider`'s
    // `vector_cosine_ops` HNSW index and `InMemorySemanticMemoryProvider`'s own
    // `cosineSimilarity()`, for the exact same facts/query/embeddings. Every provider in this
    // family must rank the same way for "provider-agnostic" to actually mean something.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(scope TEXT partition key, embedding float[${dimensions}] distance_metric=cosine)`,
    );
    this.vecDimensions = dimensions;
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content], { type: "passage" });
    if (!vector) return;

    // Before the insert, not after: a vector of the wrong width must fail without leaving a
    // metadata row behind that the vector index doesn't have.
    if (this.vecAvailable) this.ensureVecTable(vector.length);

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
      this.db
        .prepare(`INSERT INTO ${VEC_TABLE}(rowid, scope, embedding) VALUES (?, ?, ?)`)
        .run(result.lastInsertRowid, scopeKey(ref), new Float32Array(vector));
    }
  }

  /** Batches the embedding call for all `facts` into one `embed()` invocation, and wraps every
   *  insert in a single transaction — see `IBulkSemanticMemoryProvider`. */
  async rememberMany(ref: ResourceRef, facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    const vectors = await this.embeddings.embed(
      facts.map((f) => f.content),
      { type: "passage" },
    );

    // Sized from the first real vector seen, before any statement referencing the vec table is
    // prepared — preparing an INSERT against a virtual table that doesn't exist yet fails
    // immediately, so this must happen before `insertVec` below.
    if (this.vecAvailable) {
      const firstVector = vectors.find((v): v is number[] => v != null);
      if (firstVector) this.ensureVecTable(firstVector.length);
    }

    const scope = scopeKey(ref);
    const insertMeta = this.db.prepare(
      `INSERT INTO alineo_semantic_memory
         (id, scope, content, vector, source_sandbox_id, source_entry_index, remembered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec =
      this.vecAvailable && this.vecDimensions != null
        ? this.db.prepare(`INSERT INTO ${VEC_TABLE}(rowid, scope, embedding) VALUES (?, ?, ?)`)
        : null;
    const now = Date.now();

    const runAll = this.db.transaction(() => {
      for (let i = 0; i < facts.length; i++) {
        const vector = vectors[i];
        const fact = facts[i]!;
        if (!vector) continue;
        const result = insertMeta.run(
          crypto.randomUUID(),
          scope,
          fact.content,
          JSON.stringify(vector),
          fact.sourceRef?.sandboxId ?? null,
          fact.sourceRef?.entryIndex ?? null,
          now,
        );
        insertVec?.run(result.lastInsertRowid, scope, new Float32Array(vector));
      }
    });
    runAll();
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
      return rows.map(factFromRow);
    }

    // Fallback: in-JS cosine scan, same as InMemorySemanticMemoryProvider.
    const rows = this.db
      .prepare<Row, [string]>("SELECT * FROM alineo_semantic_memory WHERE scope = ?")
      .all(scopeKey(ref));
    if (rows.length === 0) return [];
    return rows
      .map((row) => ({
        row,
        score: cosineSimilarity(queryVector, JSON.parse(row.vector) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row }) => factFromRow(row));
  }

  async listAll(ref: ResourceRef): Promise<RememberedFact[]> {
    const rows = this.db
      .prepare<Row, [string]>("SELECT * FROM alineo_semantic_memory WHERE scope = ?")
      .all(scopeKey(ref));
    return rows.map(factFromRow);
  }

  /**
   * The `limit` most recently remembered facts, newest first — a bounded read for callers that
   * page through a resource's facts, so a large store isn't deserialized just to show ten.
   * `listAll()` is the unbounded form (and what compaction and `Memory.fork()` need).
   */
  async listRecent(ref: ResourceRef, limit: number): Promise<RememberedFact[]> {
    const rows = this.db
      .prepare<Row, [string, number]>(
        "SELECT * FROM alineo_semantic_memory WHERE scope = ? ORDER BY remembered_at DESC, rowid_key DESC LIMIT ?",
      )
      .all(scopeKey(ref), Math.max(0, Math.floor(limit)));
    return rows.map(factFromRow);
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

import { type ResourceRef, scopeKey } from "./types";

/**
 * Independently pluggable embedding source — constructor input to a real
 * `ISemanticMemoryProvider` implementation, the same way `nvidiaProvider` is passed into
 * `languageModel()` in `@alineo-labs/model-providers` today. This package only needs to know
 * the shape; it never depends on a concrete provider.
 */
export interface EmbeddingProvider {
  id: string;
  /**
   * `opts.type` distinguishes embedding a fact being *stored* (`"passage"`) from embedding a
   * search string at *recall* time (`"query"`) — asymmetric embedding models (most real ones,
   * including NVIDIA NIM's) rank meaningfully better when this matches how the text is
   * actually used, and conflating the two silently degrades relevance rather than erroring.
   * Optional and provider-defined: a symmetric or single-purpose provider is free to ignore it.
   */
  embed(texts: string[], opts?: { type?: "query" | "passage" }): Promise<number[][]>;
}

/** One recalled or remembered fact. */
export interface MemoryFact {
  content: string;
  /**
   * Ties a fact back to the ledger entry it was derived from — the "verified memory" idea
   * from the exploration research (a fact is trustworthy exactly when it's traceable to a
   * real ledger entry, not a hallucinated summary). Backend-agnostic: it's just an opaque
   * pointer the caller supplies, alineo-specific but not provider-specific.
   */
  sourceRef?: { sandboxId: string; entryIndex: number };
  /**
   * Whether this fact is traceable to a real ledger entry. Always **computed**, never
   * caller-set: every conforming provider derives it as `sourceRef != null` at `remember()`
   * time and ignores any value passed in on the input `MemoryFact` — a caller can't just
   * claim `verified: true` for a free-form fact. Meaningless (and absent) on `remember()`
   * input; always present on facts returned by `recall()`/`listAll()`.
   */
  verified?: boolean;
}

/**
 * Semantic recall is independently pluggable and may not exist at all — mirroring Mastra's
 * `MastraVector | false` split rather than LangGraph's opt-in-config, because working and
 * semantic memory are already two separate provider slots on `MemoryOptions`, so there's no
 * single object to attach an index config to.
 */
export interface ISemanticMemoryProvider {
  remember(ref: ResourceRef, fact: MemoryFact): Promise<void>;
  recall(ref: ResourceRef, query: string, opts?: { topK?: number }): Promise<MemoryFact[]>;
}

/** A fact as returned by `IPrunableSemanticMemoryProvider.listAll` — every provider that
 * supports pruning must give each fact a stable `id` (so `forget()` can name it after a
 * separate round trip — a plain object-identity check would break on a real, persisted
 * backend where `listAll()` reconstructs fresh objects from rows) and say when it was
 * remembered. */
export type RememberedFact = MemoryFact & { id: string; rememberedAt: number };

/**
 * Optional capability: a semantic memory provider that can enumerate and remove its own
 * facts. Kept separate from `ISemanticMemoryProvider` rather than added to it — most callers
 * only ever `remember()`/`recall()`, and not every provider needs to support pruning to be
 * useful (an append-only audit-style store, for instance). `compactSemanticMemory()` requires
 * this capability; `Memory` checks for it structurally rather than requiring every provider
 * to implement it.
 */
export interface IPrunableSemanticMemoryProvider extends ISemanticMemoryProvider {
  /** Every fact currently stored for this resource, newest or oldest first is unspecified. */
  listAll(ref: ResourceRef): Promise<RememberedFact[]>;
  /** Remove the facts with these `id`s. Returns the number actually removed. */
  forget(ref: ResourceRef, ids: string[]): Promise<number>;
}

/** True if `provider` implements the optional pruning capability. */
export function isPrunable(
  provider: ISemanticMemoryProvider,
): provider is IPrunableSemanticMemoryProvider {
  return (
    typeof (provider as Partial<IPrunableSemanticMemoryProvider>).listAll === "function" &&
    typeof (provider as Partial<IPrunableSemanticMemoryProvider>).forget === "function"
  );
}

/**
 * Optional capability: a semantic memory provider that can remember many facts in one call,
 * batching the embedding call (one `embed()` invocation covering every fact's content) instead
 * of one `embed()` per fact. `Memory.fork()` uses this when copying a resource's semantic
 * memory wholesale — without it, forking a resource with hundreds of facts means hundreds of
 * sequential embedding-API round trips just to reproduce vectors for content that's already
 * known. Falls back to plain `remember()` calls (still parallelized, but not batched) for a
 * provider that doesn't implement this.
 */
export interface IBulkSemanticMemoryProvider extends ISemanticMemoryProvider {
  rememberMany(ref: ResourceRef, facts: MemoryFact[]): Promise<void>;
}

/** True if `provider` implements the optional bulk-remember capability. */
export function isBulkRememberable(
  provider: ISemanticMemoryProvider,
): provider is IBulkSemanticMemoryProvider {
  return typeof (provider as Partial<IBulkSemanticMemoryProvider>).rememberMany === "function";
}

/**
 * Row shape common to `@alineo-labs/sqlite-memory` and `@alineo-labs/postgres-memory`'s
 * semantic-memory tables — both store the same columns, differing only in what each driver
 * hands back for `remembered_at` (a `number` from `bun:sqlite`, a numeric-string from
 * `postgres`'s `BIGINT`; callers `Number()`-coerce before calling this).
 */
export interface SemanticFactRow {
  id: string;
  content: string;
  source_sandbox_id: string | null;
  source_entry_index: number | null;
  remembered_at: number;
}

/** Shared row→fact mapping for any backend storing facts in the shape above — exported so
 *  `@alineo-labs/sqlite-memory` and `@alineo-labs/postgres-memory` don't each hand-roll the
 *  same conversion (including the `verified` derivation) with their own copy of this logic. */
export function factFromRow(row: SemanticFactRow): RememberedFact {
  return {
    content: row.content,
    sourceRef:
      row.source_sandbox_id != null
        ? { sandboxId: row.source_sandbox_id, entryIndex: row.source_entry_index! }
        : undefined,
    // Derived, not a stored column — same "computed, not caller-set" rule as remember()'s own
    // in-memory implementation above.
    verified: row.source_sandbox_id != null,
    id: row.id,
    rememberedAt: row.remembered_at,
  };
}

/** Shared ranking primitive for any backend doing its own naive (non-indexed) vector scan —
 * exported so real backends (`@alineo-labs/sqlite-memory`, `@alineo-labs/postgres-memory`)
 * don't each reimplement it. A backend with a real vector index (pgvector, sqlite-vec) should
 * rank in SQL instead and never needs this. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reference implementation — an array per resource, ranked by naive cosine similarity over
 * whatever `EmbeddingProvider` is passed in. Same purpose as `InMemoryWorkingMemoryProvider`:
 * proves the interface composes end to end, gives tests something real to run against, not a
 * production recommendation (no persistence, no approximate-nearest-neighbor indexing —
 * O(n) scan per `recall()`).
 */
export class InMemorySemanticMemoryProvider
  implements IPrunableSemanticMemoryProvider, IBulkSemanticMemoryProvider
{
  private readonly entries = new Map<string, { fact: RememberedFact; vector: number[] }[]>();

  constructor(private readonly embeddings: EmbeddingProvider) {}

  /** Batches the embedding call for all `facts` into one `embed()` invocation — see
   *  `IBulkSemanticMemoryProvider`. */
  async rememberMany(ref: ResourceRef, facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    const vectors = await this.embeddings.embed(
      facts.map((f) => f.content),
      { type: "passage" },
    );
    const key = scopeKey(ref);
    const bucket = this.entries.get(key) ?? [];
    const now = Date.now();
    for (let i = 0; i < facts.length; i++) {
      const vector = vectors[i];
      const fact = facts[i]!;
      if (!vector) continue;
      bucket.push({
        fact: {
          content: fact.content,
          sourceRef: fact.sourceRef,
          verified: fact.sourceRef != null,
          id: crypto.randomUUID(),
          rememberedAt: now,
        },
        vector,
      });
    }
    this.entries.set(key, bucket);
  }

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content], { type: "passage" });
    if (!vector) return;
    const key = scopeKey(ref);
    const bucket = this.entries.get(key) ?? [];
    // `verified` is computed here, not spread in from `fact` — a caller passing
    // `verified: true` on a free-form fact must not be able to make it stick.
    bucket.push({
      fact: {
        content: fact.content,
        sourceRef: fact.sourceRef,
        verified: fact.sourceRef != null,
        id: crypto.randomUUID(),
        rememberedAt: Date.now(),
      },
      vector,
    });
    this.entries.set(key, bucket);
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const bucket = this.entries.get(scopeKey(ref));
    if (!bucket || bucket.length === 0) return [];

    const [queryVector] = await this.embeddings.embed([query], { type: "query" });
    if (!queryVector) return [];

    const topK = opts.topK ?? 5;
    return bucket
      .map((entry) => ({ fact: entry.fact, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((ranked) => ranked.fact);
  }

  async listAll(ref: ResourceRef): Promise<RememberedFact[]> {
    return (this.entries.get(scopeKey(ref)) ?? []).map((entry) => entry.fact);
  }

  async forget(ref: ResourceRef, ids: string[]): Promise<number> {
    const key = scopeKey(ref);
    const bucket = this.entries.get(key);
    if (!bucket) return 0;
    const idSet = new Set(ids);
    const kept = bucket.filter((entry) => !idSet.has(entry.fact.id));
    const removed = bucket.length - kept.length;
    this.entries.set(key, kept);
    return removed;
  }
}

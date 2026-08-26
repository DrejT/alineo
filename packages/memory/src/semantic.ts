import { type ResourceRef, scopeKey } from "./types";

/**
 * Independently pluggable embedding source — constructor input to a real
 * `ISemanticMemoryProvider` implementation, the same way `nvidiaProvider` is passed into
 * `languageModel()` in `@alineo-labs/model-providers` today. This package only needs to know
 * the shape; it never depends on a concrete provider.
 */
export interface EmbeddingProvider {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
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

function cosineSimilarity(a: number[], b: number[]): number {
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
export class InMemorySemanticMemoryProvider implements ISemanticMemoryProvider {
  private readonly entries = new Map<string, { fact: MemoryFact; vector: number[] }[]>();

  constructor(private readonly embeddings: EmbeddingProvider) {}

  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    const [vector] = await this.embeddings.embed([fact.content]);
    if (!vector) return;
    const key = scopeKey(ref);
    const bucket = this.entries.get(key) ?? [];
    bucket.push({ fact, vector });
    this.entries.set(key, bucket);
  }

  async recall(
    ref: ResourceRef,
    query: string,
    opts: { topK?: number } = {},
  ): Promise<MemoryFact[]> {
    const bucket = this.entries.get(scopeKey(ref));
    if (!bucket || bucket.length === 0) return [];

    const [queryVector] = await this.embeddings.embed([query]);
    if (!queryVector) return [];

    const topK = opts.topK ?? 5;
    return bucket
      .map((entry) => ({ fact: entry.fact, score: cosineSimilarity(queryVector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((ranked) => ranked.fact);
  }
}

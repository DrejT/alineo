import { type ResourceRef, scopeKey } from "./types";

/**
 * Structured, per-resource key/value facts — the smallest, cheapest-to-build memory
 * capability (Phase 0 of the exploration research). Every deployment needs at least this;
 * it's the only required provider on `MemoryOptions`.
 */
export interface IWorkingMemoryProvider<V = unknown> {
  get(ref: ResourceRef, key: string): Promise<V | undefined>;
  set(ref: ResourceRef, key: string, value: V): Promise<void>;
  list(ref: ResourceRef): Promise<Record<string, V>>;
  delete(ref: ResourceRef, key: string): Promise<void>;
}

/**
 * Reference implementation — a process-local `Map`. Not durable across restarts, not shared
 * across processes or hosts. Exists to prove `IWorkingMemoryProvider` composes with `Memory`,
 * to give unit tests something to run against without a real database, and to give a first
 * consumer something to hold before a real backend package (Postgres, SQLite, ...) exists.
 * Not a production recommendation — the same relationship `InMemoryStore` has to LangGraph's
 * real backends.
 */
export class InMemoryWorkingMemoryProvider<V = unknown> implements IWorkingMemoryProvider<V> {
  private readonly buckets = new Map<string, Map<string, V>>();

  private bucketFor(ref: ResourceRef): Map<string, V> {
    const key = scopeKey(ref);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = new Map();
      this.buckets.set(key, bucket);
    }

    return bucket;
  }

  async get(ref: ResourceRef, key: string): Promise<V | undefined> {
    return this.buckets.get(scopeKey(ref))?.get(key);
  }

  async set(ref: ResourceRef, key: string, value: V): Promise<void> {
    this.bucketFor(ref).set(key, value);
  }

  async list(ref: ResourceRef): Promise<Record<string, V>> {
    const bucket = this.buckets.get(scopeKey(ref));

    return bucket ? Object.fromEntries(bucket) : {};
  }

  async delete(ref: ResourceRef, key: string): Promise<void> {
    this.buckets.get(scopeKey(ref))?.delete(key);
  }
}

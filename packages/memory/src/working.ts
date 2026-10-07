import { type ResourceRef, scopeKey } from "./types";

/**
 * Structured, per-resource key/value facts — the smallest, cheapest-to-build memory
 * capability (Phase 0 of the exploration research). Every deployment needs at least this;
 * it's the only required provider on `MemoryOptions`.
 */
export interface IWorkingMemoryProvider {
  get(ref: ResourceRef, key: string): Promise<unknown | undefined>;
  set(ref: ResourceRef, key: string, value: unknown): Promise<void>;
  list(ref: ResourceRef): Promise<Record<string, unknown>>;
  delete(ref: ResourceRef, key: string): Promise<void>;
}

/**
 * Optional capability: read one page of a resource's entries, in ascending key order (UTF-8 byte
 * order), without loading the rest. `list()` returns everything and so costs in proportion to how
 * much the resource has stored; a provider with an ordered index can answer a page in proportion
 * to the page.
 *
 * `entries` is an ordered list of pairs, not a record, on purpose: a JavaScript object does not
 * keep the order keys were added in — integer-like keys (`"9"`, `"10"`) come out first, in numeric
 * order — so a record would silently scramble the very order a page cursor depends on.
 */
export interface IPagedWorkingMemoryProvider extends IWorkingMemoryProvider {
  /** Up to `limit` entries whose key sorts after `after` (or from the start when omitted). */
  listPage(
    ref: ResourceRef,
    opts: { after?: string; limit: number },
  ): Promise<{ entries: Array<[key: string, value: unknown]>; more: boolean }>;
}

/** True if `provider` implements the optional paging capability. */
export function isPageable(
  provider: IWorkingMemoryProvider,
): provider is IPagedWorkingMemoryProvider {
  return typeof (provider as Partial<IPagedWorkingMemoryProvider>).listPage === "function";
}

/**
 * Reference implementation — a process-local `Map`. Not durable across restarts, not shared
 * across processes or hosts. Exists to prove `IWorkingMemoryProvider` composes with `Memory`,
 * to give unit tests something to run against without a real database, and to give a first
 * consumer something to hold before a real backend package (Postgres, SQLite, ...) exists.
 * Not a production recommendation — the same relationship `InMemoryStore` has to LangGraph's
 * real backends.
 */
export class InMemoryWorkingMemoryProvider implements IWorkingMemoryProvider {
  private readonly buckets = new Map<string, Map<string, unknown>>();

  private bucketFor(ref: ResourceRef): Map<string, unknown> {
    const key = scopeKey(ref);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  async get(ref: ResourceRef, key: string): Promise<unknown | undefined> {
    return this.buckets.get(scopeKey(ref))?.get(key);
  }

  async set(ref: ResourceRef, key: string, value: unknown): Promise<void> {
    this.bucketFor(ref).set(key, value);
  }

  async list(ref: ResourceRef): Promise<Record<string, unknown>> {
    const bucket = this.buckets.get(scopeKey(ref));
    return bucket ? Object.fromEntries(bucket) : {};
  }

  async delete(ref: ResourceRef, key: string): Promise<void> {
    this.buckets.get(scopeKey(ref))?.delete(key);
  }
}

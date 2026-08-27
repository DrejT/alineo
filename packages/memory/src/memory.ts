import { compactSemanticMemory, type CompactionOptions, type CompactionResult } from "./compaction";
import { MemoryCapabilityError } from "./errors";
import {
  isBulkRememberable,
  isPrunable,
  type ISemanticMemoryProvider,
  type MemoryFact,
} from "./semantic";
import { scopeKey, type ResourceRef } from "./types";
import type { IWorkingMemoryProvider } from "./working";

/** Auto-compaction settings — see `Memory.remember()`. Shares its thresholds with
 *  `CompactionOptions`, minus `now` (always real time here). */
export interface AutoCompactOptions {
  maxFacts?: number;
  maxAgeMs?: number;
  summarize?: CompactionOptions["summarize"];
  /** Only actually run the compaction check every Nth `remember()` call for a given resource,
   *  to bound overhead when `remember()` is called frequently. Defaults to `1` (every call). */
  checkEvery?: number;
}

export interface ForkMemoryResult {
  /** The new child resource's scope — `{resourceId: childResourceId, teamId: parentRef.teamId}`. */
  ref: ResourceRef;
  workingKeysCopied: number;
  /** `0` if there's no semantic provider configured, or it doesn't support the pruning
   *  capability (`listAll` is what makes copying possible) — semantic memory silently isn't
   *  copied in that case; working memory still is. */
  semanticFactsCopied: number;
}

export interface MemoryOptions {
  /** Required — every deployment needs at least structured working memory. */
  workingMemory: IWorkingMemoryProvider;
  /** Optional — absence is a typed, explicit state (see `MemoryCapabilityError`), not a silent no-op. */
  semantic?: ISemanticMemoryProvider;
  /**
   * When set, `remember()` automatically runs `compactSemanticMemory()` after writing, once
   * every `checkEvery` calls for a given resource — the "the package owns compaction, not the
   * caller" behavior from the original design goal. Silently skipped (not an error) if the
   * configured `semantic` provider doesn't support the pruning capability. Requires
   * `semantic` to be set; ignored otherwise.
   */
  autoCompact?: AutoCompactOptions;
}

/**
 * The provider-agnostic memory facade: one object an agent holds, backed by whichever
 * providers were configured. Plain public constructor (like `SandboxHandle`), not the
 * load/attach/spawn factory pattern `Agent` uses — `Memory` has no async setup step (no
 * snapshot restore, no bridge process) that would need a factory to hide.
 */
export class Memory {
  readonly workingMemory: {
    get(ref: ResourceRef, key: string): Promise<unknown | undefined>;
    set(ref: ResourceRef, key: string, value: unknown): Promise<void>;
    list(ref: ResourceRef): Promise<Record<string, unknown>>;
    delete(ref: ResourceRef, key: string): Promise<void>;
  };

  private readonly semanticProvider: ISemanticMemoryProvider | undefined;
  private readonly autoCompact: AutoCompactOptions | undefined;
  /** Per-resource remember() count since the last auto-compact check, keyed by `scopeKey`. */
  private readonly rememberCounts = new Map<string, number>();

  constructor(opts: MemoryOptions) {
    const working = opts.workingMemory;
    this.workingMemory = {
      get: (ref, key) => working.get(ref, key),
      set: (ref, key, value) => working.set(ref, key, value),
      list: (ref) => working.list(ref),
      delete: (ref, key) => working.delete(ref, key),
    };
    this.semanticProvider = opts.semantic;
    this.autoCompact = opts.autoCompact;
  }

  /** Whether this instance was configured with a semantic memory provider. */
  get hasSemanticMemory(): boolean {
    return this.semanticProvider != null;
  }

  /**
   * @throws {MemoryCapabilityError} if no semantic memory provider was configured.
   * @throws whatever `compactSemanticMemory()` throws if auto-compaction is configured and its
   *   check fires on this call — a failed compaction fails the `remember()` call it rode along
   *   with, rather than being silently swallowed. Configure `autoCompact.checkEvery` higher, or
   *   call `compactSemanticMemory()` yourself on a separate schedule, to decouple the two.
   */
  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    if (!this.semanticProvider) throw new MemoryCapabilityError("semantic");
    await this.semanticProvider.remember(ref, fact);

    if (this.autoCompact && isPrunable(this.semanticProvider)) {
      const key = scopeKey(ref);
      const count = (this.rememberCounts.get(key) ?? 0) + 1;
      this.rememberCounts.set(key, count);
      const checkEvery = this.autoCompact.checkEvery ?? 1;
      if (count % checkEvery === 0) {
        await compactSemanticMemory(this.semanticProvider, ref, this.autoCompact);
      }
    }
  }

  /** @throws {MemoryCapabilityError} if no semantic memory provider was configured. */
  async recall(ref: ResourceRef, query: string, opts?: { topK?: number }): Promise<MemoryFact[]> {
    if (!this.semanticProvider) throw new MemoryCapabilityError("semantic");
    return this.semanticProvider.recall(ref, query, opts);
  }

  /**
   * Prune old/excess facts from semantic memory — see `compactSemanticMemory()`. Distinct from
   * the automatic compaction `autoCompact` triggers: this always runs immediately, regardless
   * of `checkEvery`.
   * @throws {MemoryCapabilityError} if no semantic memory provider was configured.
   * @throws if the configured provider doesn't support the pruning capability
   *   (`IPrunableSemanticMemoryProvider`).
   */
  async compactSemanticMemory(
    ref: ResourceRef,
    opts?: CompactionOptions,
  ): Promise<CompactionResult> {
    if (!this.semanticProvider) throw new MemoryCapabilityError("semantic");
    return compactSemanticMemory(this.semanticProvider, ref, opts);
  }

  /**
   * Copy a resource's current memory into a brand-new resource scope the child can mutate
   * independently — the memory-layer counterpart to `sb.fork()`'s copy-on-write sandbox
   * snapshot. Unlike `episodicRecall({branch: "lineage"})`, which reads the *parent's* history
   * through the child's own lens without duplicating anything, this actually writes a real,
   * independent copy: mutating the child's memory afterward never touches the parent's.
   *
   * Working memory is always copied in full. Semantic memory is copied only if the configured
   * provider supports the pruning capability (`listAll` is what makes enumerating "everything
   * to copy" possible) — see `ForkMemoryResult.semanticFactsCopied`. Copied semantic facts
   * keep their original `content`/`sourceRef` (so `verified` is recomputed identically by
   * whatever provider stores them) but get a fresh `id`/`rememberedAt` from the provider, same
   * as any other `remember()` call.
   *
   * Both copy steps run their per-item writes concurrently (`Promise.all`), not sequentially.
   * Semantic facts are additionally batched into one `embed()` call, not one per fact, when the
   * provider supports the optional `IBulkSemanticMemoryProvider` capability (all three shipped
   * providers do) — re-deriving vectors for content the provider already embedded once is
   * otherwise a full round trip to the embedding API per fact.
   *
   * Does not read or write anything about the *sandbox* itself — call this alongside
   * `sb.fork()`/`Alineo.spawn()`, not instead of it. `Alineo.spawn()` already calls this
   * automatically when the parent agent has `.memory` configured.
   */
  async fork(parentRef: ResourceRef, childResourceId: string): Promise<ForkMemoryResult> {
    const childRef: ResourceRef = { resourceId: childResourceId, teamId: parentRef.teamId };

    const working = await this.workingMemory.list(parentRef);
    await Promise.all(
      Object.entries(working).map(([key, value]) => this.workingMemory.set(childRef, key, value)),
    );

    let semanticFactsCopied = 0;
    if (this.semanticProvider && isPrunable(this.semanticProvider)) {
      const semanticProvider = this.semanticProvider;
      const facts = await semanticProvider.listAll(parentRef);
      const toCopy: MemoryFact[] = facts.map((f) => ({
        content: f.content,
        sourceRef: f.sourceRef,
      }));
      if (isBulkRememberable(semanticProvider)) {
        await semanticProvider.rememberMany(childRef, toCopy);
      } else {
        await Promise.all(toCopy.map((f) => semanticProvider.remember(childRef, f)));
      }
      semanticFactsCopied = facts.length;
    }

    return { ref: childRef, workingKeysCopied: Object.keys(working).length, semanticFactsCopied };
  }
}

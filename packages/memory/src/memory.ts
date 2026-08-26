import { compactSemanticMemory, type CompactionOptions, type CompactionResult } from "./compaction";
import { MemoryCapabilityError } from "./errors";
import type { ISemanticMemoryProvider, MemoryFact } from "./semantic";
import type { ResourceRef } from "./types";
import type { IWorkingMemoryProvider } from "./working";

export interface MemoryOptions {
  /** Required — every deployment needs at least structured working memory. */
  workingMemory: IWorkingMemoryProvider;
  /** Optional — absence is a typed, explicit state (see `MemoryCapabilityError`), not a silent no-op. */
  semantic?: ISemanticMemoryProvider;
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

  constructor(opts: MemoryOptions) {
    const working = opts.workingMemory;
    this.workingMemory = {
      get: (ref, key) => working.get(ref, key),
      set: (ref, key, value) => working.set(ref, key, value),
      list: (ref) => working.list(ref),
      delete: (ref, key) => working.delete(ref, key),
    };
    this.semanticProvider = opts.semantic;
  }

  /** Whether this instance was configured with a semantic memory provider. */
  get hasSemanticMemory(): boolean {
    return this.semanticProvider != null;
  }

  /** @throws {MemoryCapabilityError} if no semantic memory provider was configured. */
  async remember(ref: ResourceRef, fact: MemoryFact): Promise<void> {
    if (!this.semanticProvider) throw new MemoryCapabilityError("semantic");
    return this.semanticProvider.remember(ref, fact);
  }

  /** @throws {MemoryCapabilityError} if no semantic memory provider was configured. */
  async recall(ref: ResourceRef, query: string, opts?: { topK?: number }): Promise<MemoryFact[]> {
    if (!this.semanticProvider) throw new MemoryCapabilityError("semantic");
    return this.semanticProvider.recall(ref, query, opts);
  }

  /**
   * Prune old/excess facts from semantic memory — see `compactSemanticMemory()`.
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
}

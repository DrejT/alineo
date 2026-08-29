import { isPrunable } from "./semantic";
import type {
  IPrunableSemanticMemoryProvider,
  ISemanticMemoryProvider,
  RememberedFact,
} from "./semantic";
import type { ResourceRef } from "./types";

export interface CompactionOptions {
  /** Drop the oldest facts beyond this count, keeping the most recently remembered ones. */
  maxFacts?: number;
  /** Drop any fact remembered more than this many milliseconds ago. */
  maxAgeMs?: number;
  /** Override "now" for age comparisons — mainly for tests. Defaults to `Date.now()`. */
  now?: number;
  /**
   * When set, facts selected for removal are summarized rather than just discarded: this
   * function receives the to-be-removed facts (oldest first) and returns the contents of
   * fewer, denser replacement facts, which are `remember()`'d *before* the originals are
   * removed — pruning that consolidates information instead of throwing it away. Typically a
   * thin wrapper around an LLM call ("summarize these N facts into fewer bullet points"); the
   * function itself is caller-supplied so this package never depends on a concrete model.
   * Replacement facts carry no `sourceRef` — they're synthesized, not tied to one ledger entry.
   * Omit to fall back to plain deletion.
   */
  summarize?: (facts: RememberedFact[]) => Promise<string[]>;
}

export interface CompactionResult {
  removed: number;
  remaining: number;
  /** Number of consolidated replacement facts written by `summarize`, if it was set and had
   *  something to summarize. `0` when `summarize` was omitted or nothing was removed. */
  summarized: number;
}

/**
 * Prune a resource's semantic memory so facts don't accumulate forever. Without this, a
 * `remember()`'d fact stays verbatim until manually deleted — fine for a demo, not for an
 * agent that runs for months. Requires a provider that supports the optional
 * `IPrunableSemanticMemoryProvider` capability (`listAll`/`forget`); throws otherwise, same
 * "loud on missing capability" convention as `Memory.remember()`/`recall()`.
 *
 * Both `maxAgeMs` and `maxFacts` may be set together — age-based removal runs first, then the
 * count cap is applied to whatever's left. Neither set is a no-op (returns `{removed: 0, ...}`
 * without calling `forget()`).
 */
export async function compactSemanticMemory(
  provider: ISemanticMemoryProvider,
  ref: ResourceRef,
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  if (!isPrunable(provider)) {
    throw new Error(
      "compactSemanticMemory() requires a provider implementing IPrunableSemanticMemoryProvider (listAll/forget) — this provider only implements remember/recall.",
    );
  }
  return compactPrunable(provider, ref, opts);
}

async function compactPrunable(
  provider: IPrunableSemanticMemoryProvider,
  ref: ResourceRef,
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const now = opts.now ?? Date.now();
  const facts = await provider.listAll(ref);

  const toRemove = new Set<string>();

  if (opts.maxAgeMs != null) {
    for (const fact of facts) {
      if (now - fact.rememberedAt > opts.maxAgeMs) toRemove.add(fact.id);
    }
  }

  if (opts.maxFacts != null) {
    const remaining = facts.filter((f) => !toRemove.has(f.id));
    if (remaining.length > opts.maxFacts) {
      const oldestFirst = [...remaining].sort((a, b) => a.rememberedAt - b.rememberedAt);
      const excess = oldestFirst.length - opts.maxFacts;
      for (let i = 0; i < excess; i++) toRemove.add(oldestFirst[i]!.id);
    }
  }

  if (toRemove.size === 0) return { removed: 0, remaining: facts.length, summarized: 0 };

  let summarized = 0;
  if (opts.summarize) {
    // Oldest first — a summarizer condensing "what happened over time" reads better in
    // chronological order than an arbitrary one.
    const removedFacts = facts
      .filter((f) => toRemove.has(f.id))
      .sort((a, b) => a.rememberedAt - b.rememberedAt);
    const consolidated = await opts.summarize(removedFacts);
    for (const content of consolidated) {
      await provider.remember(ref, { content });
    }
    summarized = consolidated.length;
  }

  const removed = await provider.forget(ref, [...toRemove]);
  // Not `facts.length - removed + summarized` — that arithmetic assumes `facts.length` (this
  // call's own pre-compaction snapshot) is still accurate at the moment `forget()` runs, which
  // isn't true under concurrent compaction on the same resource: a second call's snapshot can
  // include facts a first, overlapping call already deleted, so the first call's own `removed`
  // count (accurate for what it actually deleted) gets combined with a now-stale total. A fresh
  // `listAll()` after `forget()` reports the true count regardless of what else ran concurrently.
  const remaining = (await provider.listAll(ref)).length;
  return { removed, remaining, summarized };
}

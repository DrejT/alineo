import { describe, expect, it } from "vitest";
import { compactSemanticMemory } from "../src/compaction.ts";
import { InMemorySemanticMemoryProvider } from "../src/semantic.ts";
import type { EmbeddingProvider, ISemanticMemoryProvider } from "../src/semantic.ts";
import type { ResourceRef } from "../src/types.ts";

function fakeEmbeddings(): EmbeddingProvider {
  return {
    id: "fake",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };
}

const ref: ResourceRef = { resourceId: "user-1" };

describe("compactSemanticMemory", () => {
  it("throws when the provider doesn't support the pruning capability", async () => {
    const notPrunable: ISemanticMemoryProvider = {
      remember: async () => {},
      recall: async () => [],
    };

    await expect(compactSemanticMemory(notPrunable, ref, { maxFacts: 1 })).rejects.toThrow(
      /IPrunableSemanticMemoryProvider/,
    );
  });

  it("is a no-op when neither maxFacts nor maxAgeMs is set", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember(ref, { content: "a" });

    const result = await compactSemanticMemory(provider, ref);

    expect(result).toEqual({ removed: 0, remaining: 1 });
    expect(await provider.listAll(ref)).toHaveLength(1);
  });

  it("removes the oldest facts beyond maxFacts, keeping the most recent", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember(ref, { content: "first" });
    await provider.remember(ref, { content: "second" });
    await provider.remember(ref, { content: "third" });

    const result = await compactSemanticMemory(provider, ref, { maxFacts: 2 });

    expect(result).toEqual({ removed: 1, remaining: 2 });
    const remaining = (await provider.listAll(ref)).map((f) => f.content);
    expect(remaining).toEqual(["second", "third"]);
  });

  it("removes facts older than maxAgeMs", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember(ref, { content: "old" });
    const midpoint = Date.now() + 10;
    await new Promise((r) => setTimeout(r, 20));
    await provider.remember(ref, { content: "new" });

    const result = await compactSemanticMemory(provider, ref, {
      maxAgeMs: 0,
      now: midpoint,
    });

    expect(result.removed).toBe(1);
    const remaining = (await provider.listAll(ref)).map((f) => f.content);
    expect(remaining).toEqual(["new"]);
  });

  it("applies maxAgeMs before maxFacts when both are set", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember(ref, { content: "ancient" });
    const cutoff = Date.now() + 10;
    await new Promise((r) => setTimeout(r, 20));
    await provider.remember(ref, { content: "recent-1" });
    await provider.remember(ref, { content: "recent-2" });

    // maxAgeMs drops "ancient"; maxFacts=5 has nothing left to cap.
    const result = await compactSemanticMemory(provider, ref, {
      maxAgeMs: 0,
      now: cutoff,
      maxFacts: 5,
    });

    expect(result).toEqual({ removed: 1, remaining: 2 });
  });

  it("does not affect other resources", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember(ref, { content: "a" });
    await provider.remember({ resourceId: "user-2" }, { content: "b" });

    await compactSemanticMemory(provider, ref, { maxFacts: 0 });

    expect(await provider.listAll(ref)).toHaveLength(0);
    expect(await provider.listAll({ resourceId: "user-2" })).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { InMemorySemanticMemoryProvider } from "../src/semantic.ts";
import type { EmbeddingProvider } from "../src/semantic.ts";
import type { ResourceRef } from "../src/types.ts";

/** Deterministic fake: each text maps to a fixed 2D vector by keyword, so similarity ranking
 * is predictable in tests without a real embedding model. */
function fakeEmbeddings(): EmbeddingProvider {
  return {
    id: "fake",
    async embed(texts) {
      return texts.map((t) => {
        const lower = t.toLowerCase();
        if (lower.includes("cat")) return [1, 0];
        if (lower.includes("dog")) return [0, 1];
        return [0.5, 0.5];
      });
    },
  };
}

describe("InMemorySemanticMemoryProvider", () => {
  it("recalls facts ranked by similarity to the query", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    const ref: ResourceRef = { resourceId: "user-1" };

    await provider.remember(ref, { content: "I have a pet cat named Whiskers" });
    await provider.remember(ref, { content: "I have a pet dog named Rex" });

    const results = await provider.recall(ref, "tell me about the cat");

    expect(results[0]?.content).toContain("cat");
  });

  it("respects topK", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    const ref: ResourceRef = { resourceId: "user-1" };
    await provider.remember(ref, { content: "cat fact 1" });
    await provider.remember(ref, { content: "cat fact 2" });
    await provider.remember(ref, { content: "dog fact 1" });

    const results = await provider.recall(ref, "cat", { topK: 1 });

    expect(results).toHaveLength(1);
  });

  it("returns an empty array when nothing has been remembered for the resource", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    expect(await provider.recall({ resourceId: "never-remembered" }, "anything")).toEqual([]);
  });

  it("isolates facts between different resourceIds", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact" });

    expect(await provider.recall({ resourceId: "user-2" }, "cat")).toEqual([]);
  });

  it("preserves sourceRef on remembered facts", async () => {
    const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
    const ref: ResourceRef = { resourceId: "user-1" };
    await provider.remember(ref, {
      content: "cat fact",
      sourceRef: { sandboxId: "sb-1", entryIndex: 3 },
    });

    const [fact] = await provider.recall(ref, "cat");

    expect(fact?.sourceRef).toEqual({ sandboxId: "sb-1", entryIndex: 3 });
  });

  describe("verified", () => {
    it("marks a fact remembered with a sourceRef as verified", async () => {
      const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const ref: ResourceRef = { resourceId: "user-1" };
      await provider.remember(ref, {
        content: "cat fact",
        sourceRef: { sandboxId: "sb-1", entryIndex: 3 },
      });

      const [fact] = await provider.recall(ref, "cat");

      expect(fact?.verified).toBe(true);
    });

    it("marks a free-form fact (no sourceRef) as unverified", async () => {
      const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const ref: ResourceRef = { resourceId: "user-1" };
      await provider.remember(ref, { content: "cat fact" });

      const [fact] = await provider.recall(ref, "cat");

      expect(fact?.verified).toBe(false);
    });

    it("ignores a caller-supplied verified:true on a free-form fact — it must be computed, not claimed", async () => {
      const provider = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const ref: ResourceRef = { resourceId: "user-1" };

      // Attempting to lie about verification without a real sourceRef.
      await provider.remember(ref, { content: "cat fact", verified: true } as never);

      const [fact] = await provider.recall(ref, "cat");

      expect(fact?.verified).toBe(false);
    });
  });
});

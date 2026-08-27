import { describe, expect, it } from "vitest";
import { MemoryCapabilityError } from "../src/errors.ts";
import { Memory } from "../src/memory.ts";
import { InMemorySemanticMemoryProvider } from "../src/semantic.ts";
import type { EmbeddingProvider } from "../src/semantic.ts";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";

function fakeEmbeddings(): EmbeddingProvider {
  return {
    id: "fake",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };
}

describe("Memory", () => {
  it("delegates working memory calls to the configured provider", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const ref = { resourceId: "user-1" };

    await memory.workingMemory.set(ref, "key", "value");

    expect(await memory.workingMemory.get(ref, "key")).toBe("value");
    expect(await memory.workingMemory.list(ref)).toEqual({ key: "value" });

    await memory.workingMemory.delete(ref, "key");
    expect(await memory.workingMemory.get(ref, "key")).toBeUndefined();
  });

  it("reports hasSemanticMemory as false when no semantic provider was configured", () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    expect(memory.hasSemanticMemory).toBe(false);
  });

  it("throws MemoryCapabilityError on remember() with no semantic provider", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

    await expect(memory.remember({ resourceId: "user-1" }, { content: "fact" })).rejects.toThrow(
      MemoryCapabilityError,
    );
  });

  it("throws MemoryCapabilityError on recall() with no semantic provider", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

    await expect(memory.recall({ resourceId: "user-1" }, "query")).rejects.toThrow(
      MemoryCapabilityError,
    );
  });

  it("delegates remember/recall when a semantic provider is configured", async () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    const ref = { resourceId: "user-1" };

    expect(memory.hasSemanticMemory).toBe(true);
    await memory.remember(ref, { content: "the sky is blue" });

    const results = await memory.recall(ref, "sky");
    expect(results[0]?.content).toBe("the sky is blue");
  });

  describe("autoCompact", () => {
    it("runs a compaction check after every remember() by default", async () => {
      const semantic = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic,
        autoCompact: { maxFacts: 1 },
      });
      const ref = { resourceId: "user-1" };

      await memory.remember(ref, { content: "first" });
      await memory.remember(ref, { content: "second" });

      expect(await semantic.listAll(ref)).toHaveLength(1);
    });

    it("only checks every Nth remember() call when checkEvery is set", async () => {
      const semantic = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic,
        autoCompact: { maxFacts: 1, checkEvery: 3 },
      });
      const ref = { resourceId: "user-1" };

      await memory.remember(ref, { content: "a" });
      await memory.remember(ref, { content: "b" });
      expect(await semantic.listAll(ref)).toHaveLength(2); // not checked yet

      await memory.remember(ref, { content: "c" }); // 3rd call triggers the check

      expect(await semantic.listAll(ref)).toHaveLength(1);
    });

    it("does nothing when the configured semantic provider doesn't support pruning", async () => {
      const notPrunable = {
        remember: async () => {},
        recall: async () => [],
      };
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic: notPrunable,
        autoCompact: { maxFacts: 0 },
      });

      await expect(
        memory.remember({ resourceId: "user-1" }, { content: "fact" }),
      ).resolves.toBeUndefined();
    });

    it("does not run when autoCompact is not configured", async () => {
      const semantic = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider(), semantic });
      const ref = { resourceId: "user-1" };

      await memory.remember(ref, { content: "a" });
      await memory.remember(ref, { content: "b" });

      expect(await semantic.listAll(ref)).toHaveLength(2);
    });
  });

  describe("fork", () => {
    it("copies working memory into a new, independent resource scope", async () => {
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
      const parentRef = { resourceId: "parent" };
      await memory.workingMemory.set(parentRef, "name", "Ada");

      const result = await memory.fork(parentRef, "child");

      expect(result.ref).toEqual({ resourceId: "child", teamId: undefined });
      expect(result.workingKeysCopied).toBe(1);
      expect(await memory.workingMemory.get(result.ref, "name")).toBe("Ada");
    });

    it("the copy is independent — mutating the child never touches the parent", async () => {
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
      const parentRef = { resourceId: "parent" };
      await memory.workingMemory.set(parentRef, "name", "Ada");

      const { ref: childRef } = await memory.fork(parentRef, "child");
      await memory.workingMemory.set(childRef, "name", "Grace");

      expect(await memory.workingMemory.get(parentRef, "name")).toBe("Ada");
      expect(await memory.workingMemory.get(childRef, "name")).toBe("Grace");
    });

    it("preserves teamId on the child scope", async () => {
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
      const parentRef = { resourceId: "parent", teamId: "team-a" };

      const result = await memory.fork(parentRef, "child");

      expect(result.ref).toEqual({ resourceId: "child", teamId: "team-a" });
    });

    it("copies semantic memory when the provider supports pruning", async () => {
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
      });
      const parentRef = { resourceId: "parent" };
      await memory.remember(parentRef, { content: "the sky is blue" });

      const { ref: childRef, semanticFactsCopied } = await memory.fork(parentRef, "child");

      expect(semanticFactsCopied).toBe(1);
      const facts = await memory.recall(childRef, "sky");
      expect(facts[0]?.content).toBe("the sky is blue");
    });

    it("semantic copy is independent of the parent", async () => {
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
      });
      const parentRef = { resourceId: "parent" };
      await memory.remember(parentRef, { content: "shared fact" });

      const { ref: childRef } = await memory.fork(parentRef, "child");
      await memory.remember(childRef, { content: "child-only fact" });

      const parentFacts = await memory.recall(parentRef, "fact", { topK: 10 });
      expect(parentFacts.map((f) => f.content)).toEqual(["shared fact"]);
    });

    it("skips semantic copying (0, not an error) when no semantic provider is configured", async () => {
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

      const result = await memory.fork({ resourceId: "parent" }, "child");

      expect(result.semanticFactsCopied).toBe(0);
    });

    it("skips semantic copying when the configured provider doesn't support pruning", async () => {
      const notPrunable = { remember: async () => {}, recall: async () => [] };
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic: notPrunable,
      });

      const result = await memory.fork({ resourceId: "parent" }, "child");

      expect(result.semanticFactsCopied).toBe(0);
    });
  });
});

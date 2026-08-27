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
});

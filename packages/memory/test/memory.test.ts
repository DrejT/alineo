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

    it("treats checkEvery: 0 as 1 instead of silently disabling the check forever", async () => {
      // `count % 0` is NaN, never `=== 0` — without the fix, this configuration would never
      // trigger a compaction check at all, for the life of the Memory instance.
      const semantic = new InMemorySemanticMemoryProvider(fakeEmbeddings());
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic,
        autoCompact: { maxFacts: 1, checkEvery: 0 },
      });
      const ref = { resourceId: "user-1" };

      await memory.remember(ref, { content: "first" });
      await memory.remember(ref, { content: "second" });

      expect(await semantic.listAll(ref)).toHaveLength(1);
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

    it("is independent even for object values — mutating the retrieved reference doesn't leak to the parent", async () => {
      // Re-`set()`-ing a brand-new value (the test above) can't catch a reference-sharing
      // bug — it needs an object mutated *in place* after retrieval. Without a real copy on
      // fork(), InMemoryWorkingMemoryProvider stores the identical object reference for both
      // scopes, so this mutation would leak into the parent's own stored value too.
      const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
      const parentRef = { resourceId: "parent" };
      await memory.workingMemory.set(parentRef, "prefs", { theme: "light" });

      const { ref: childRef } = await memory.fork(parentRef, "child");
      const childPrefs = (await memory.workingMemory.get(childRef, "prefs")) as { theme: string };
      childPrefs.theme = "dark";

      expect(await memory.workingMemory.get(parentRef, "prefs")).toEqual({ theme: "light" });
      expect(await memory.workingMemory.get(childRef, "prefs")).toEqual({ theme: "dark" });
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

    it("semanticFactsCopied reflects facts actually written, not the pre-copy count", async () => {
      // A shipped semantic provider silently skips a fact when embed() returns a null vector
      // for it (see e.g. InMemorySemanticMemoryProvider.rememberMany()) — semanticFactsCopied
      // must report what actually landed in the child's scope, not facts.length from before
      // the copy, or a caller trusting this count to verify the fork gets a false positive.
      //
      // "shaky" only fails to embed when it's part of a *batched* call (texts.length > 1) —
      // both original remember() calls below embed one text at a time and succeed normally;
      // fork()'s rememberMany() batches both facts' content into one embed() call, which is
      // where "shaky" specifically fails this time.
      const flaky: EmbeddingProvider = {
        id: "flaky",
        async embed(texts) {
          return texts.map((t) =>
            t === "shaky" && texts.length > 1 ? undefined : [1, 0],
          ) as number[][];
        },
      };
      const memory = new Memory({
        workingMemory: new InMemoryWorkingMemoryProvider(),
        semantic: new InMemorySemanticMemoryProvider(flaky),
      });
      const parentRef = { resourceId: "parent" };
      await memory.remember(parentRef, { content: "fine" });
      await memory.remember(parentRef, { content: "shaky" });
      expect(await memory.recall(parentRef, "fine", { topK: 10 })).toHaveLength(2);

      const { semanticFactsCopied } = await memory.fork(parentRef, "child");

      expect(semanticFactsCopied).toBe(1);
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

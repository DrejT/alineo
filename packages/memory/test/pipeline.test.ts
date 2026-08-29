import { describe, expect, it } from "vitest";
import { buildContextSnippet } from "../src/pipeline.ts";
import { Memory } from "../src/memory.ts";
import { InMemorySemanticMemoryProvider } from "../src/semantic.ts";
import type { EmbeddingProvider } from "../src/semantic.ts";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";
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

describe("buildContextSnippet", () => {
  it("returns an empty string when there is nothing to say", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    expect(await buildContextSnippet(memory, ref)).toBe("");
  });

  it("includes working memory facts", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    await memory.workingMemory.set(ref, "preferredLanguage", "TypeScript");

    const snippet = await buildContextSnippet(memory, ref);

    expect(snippet).toContain("preferredLanguage");
    expect(snippet).toContain("TypeScript");
  });

  it("skips semantic recall when no query is given, even with a semantic provider configured", async () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    await memory.remember(ref, { content: "prefers dark mode" });

    const snippet = await buildContextSnippet(memory, ref);

    expect(snippet).not.toContain("dark mode");
  });

  it("skips semantic recall when a query is given but no semantic provider is configured", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });

    const snippet = await buildContextSnippet(memory, ref, { query: "anything" });

    expect(snippet).toBe("");
  });

  it("includes relevant semantic memories when both a query and a provider are present", async () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    await memory.remember(ref, { content: "prefers dark mode" });

    const snippet = await buildContextSnippet(memory, ref, { query: "UI preferences" });

    expect(snippet).toContain("prefers dark mode");
  });

  it("combines working memory and semantic sections", async () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    await memory.workingMemory.set(ref, "name", "Ada");
    await memory.remember(ref, { content: "prefers dark mode" });

    const snippet = await buildContextSnippet(memory, ref, { query: "preferences" });

    expect(snippet).toContain("Ada");
    expect(snippet).toContain("prefers dark mode");
  });

  it("caps the number of working-memory keys included", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    await memory.workingMemory.set(ref, "a", 1);
    await memory.workingMemory.set(ref, "b", 2);
    await memory.workingMemory.set(ref, "c", 3);

    const snippet = await buildContextSnippet(memory, ref, { maxWorkingMemoryKeys: 1 });

    const keyLines = snippet.split("\n").filter((l) => l.startsWith("- "));
    expect(keyLines).toHaveLength(1);
  });
});

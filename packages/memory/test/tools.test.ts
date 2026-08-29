import { describe, expect, it } from "vitest";
import { createMemoryTools } from "../src/tools.ts";
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

describe("createMemoryTools", () => {
  it("always includes the working-memory tools", () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const tools = createMemoryTools(memory, ref);

    expect(tools.map((t) => t.name)).toEqual(["set_working_memory", "get_working_memory"]);
  });

  it("adds semantic tools only when a semantic provider is configured", () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    const tools = createMemoryTools(memory, ref);

    expect(tools.map((t) => t.name)).toEqual([
      "set_working_memory",
      "get_working_memory",
      "remember_fact",
      "recall_facts",
    ]);
  });

  it("every tool has a name, description, and JSON-schema-shaped parameters", () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });

    for (const tool of createMemoryTools(memory, ref)) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("set_working_memory / get_working_memory execute against the real provider", async () => {
    const memory = new Memory({ workingMemory: new InMemoryWorkingMemoryProvider() });
    const [set, get] = createMemoryTools(memory, ref);

    await set!.execute({ key: "favoriteColor", value: "blue" });
    const result = await get!.execute({});

    expect(result).toEqual({ favoriteColor: "blue" });
  });

  it("remember_fact / recall_facts execute against the real provider", async () => {
    const memory = new Memory({
      workingMemory: new InMemoryWorkingMemoryProvider(),
      semantic: new InMemorySemanticMemoryProvider(fakeEmbeddings()),
    });
    const [, , remember, recall] = createMemoryTools(memory, ref);

    await remember!.execute({ content: "the sky is blue" });
    const result = (await recall!.execute({ query: "sky" })) as { facts: string[] };

    expect(result.facts).toEqual(["the sky is blue"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  InMemorySemanticMemoryProvider,
  InMemoryWorkingMemoryProvider,
  isPageable,
  isRecentListable,
} from "../src/index";

const embeddings = { id: "x", embed: async (t: string[]) => t.map(() => [1]) };

describe("optional-capability guards", () => {
  it("isPageable is true only for a provider that implements listPage", () => {
    expect(isPageable(new InMemoryWorkingMemoryProvider())).toBe(false);
    const paged = Object.assign(new InMemoryWorkingMemoryProvider(), {
      listPage: async () => ({ entries: [], more: false }),
    });
    expect(isPageable(paged)).toBe(true);
  });

  it("isRecentListable is true only for a provider that implements listRecent", () => {
    expect(isRecentListable(new InMemorySemanticMemoryProvider(embeddings))).toBe(false);
    const recent = Object.assign(new InMemorySemanticMemoryProvider(embeddings), {
      listRecent: async () => [],
    });
    expect(isRecentListable(recent)).toBe(true);
  });
});

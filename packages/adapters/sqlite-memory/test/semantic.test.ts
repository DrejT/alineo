import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@alineo-labs/memory";
import { SQLiteSemanticMemoryProvider } from "../src/semantic.ts";

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

describe("SQLiteSemanticMemoryProvider", () => {
  it("uses the native sqlite-vec index, not the JS fallback scan, on this platform", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact" });

    expect(provider.hasVectorIndex).toBe(true);
    provider.close();
  });

  it("keeps topK correct when another resource's facts are nearer to the query than this resource's own — the exact bug a naive post-join scope filter would hit under vec0's global top-k KNN", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    // user-2 gets many exact "cat" matches (distance 0) — if scoping were applied AFTER
    // vec0 picks its global nearest neighbors instead of natively via the partition key,
    // these would crowd out user-1's own (less exact) matches and topK would come back
    // short or wrong for user-1.
    for (let i = 0; i < 10; i++) {
      await provider.remember({ resourceId: "user-2" }, { content: `cat fact ${i}` });
    }
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact A" });
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact B" });
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact C" });

    const results = await provider.recall({ resourceId: "user-1" }, "cat", { topK: 3 });

    expect(results).toHaveLength(3);
    expect(
      results.every((f) => f.content.startsWith("cat fact ") && /[ABC]$/.test(f.content)),
    ).toBe(true);
    provider.close();
  });

  it("recalls facts ranked by similarity to the query", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };

    await provider.remember(ref, { content: "I have a pet cat named Whiskers" });
    await provider.remember(ref, { content: "I have a pet dog named Rex" });

    const results = await provider.recall(ref, "tell me about the cat");

    expect(results[0]?.content).toContain("cat");
    provider.close();
  });

  it("isolates facts between different resourceIds", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    await provider.remember({ resourceId: "user-1" }, { content: "cat fact" });

    expect(await provider.recall({ resourceId: "user-2" }, "cat")).toEqual([]);
    provider.close();
  });

  it("preserves sourceRef through the persisted round trip", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    await provider.remember(ref, {
      content: "cat fact",
      sourceRef: { sandboxId: "sb-1", entryIndex: 3 },
    });

    const [fact] = await provider.recall(ref, "cat");

    expect(fact?.sourceRef).toEqual({ sandboxId: "sb-1", entryIndex: 3 });
    provider.close();
  });

  it("listAll returns every fact with a stable id and rememberedAt", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    await provider.remember(ref, { content: "fact one" });
    await provider.remember(ref, { content: "fact two" });

    const all = await provider.listAll(ref);

    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBeTruthy();
    expect(typeof all[0]?.rememberedAt).toBe("number");
    provider.close();
  });

  it("forget removes only the named ids and returns the count removed", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    await provider.remember(ref, { content: "keep me" });
    await provider.remember(ref, { content: "forget me" });
    const [keep, drop] = await provider.listAll(ref);

    const removed = await provider.forget(ref, [drop!.id]);

    expect(removed).toBe(1);
    const remaining = await provider.listAll(ref);
    expect(remaining.map((f) => f.id)).toEqual([keep!.id]);
    provider.close();
  });

  it("forget with an empty id list is a no-op", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    await provider.remember({ resourceId: "user-1" }, { content: "fact" });

    expect(await provider.forget({ resourceId: "user-1" }, [])).toBe(0);
    provider.close();
  });

  it("survives being reopened against the same file (real persistence)", async () => {
    const { rmSync } = await import("node:fs");
    const path = `${import.meta.dir}/.tmp-semantic-${crypto.randomUUID()}.db`;
    const first = new SQLiteSemanticMemoryProvider(path, fakeEmbeddings());
    await first.remember({ resourceId: "user-1" }, { content: "cat fact" });
    first.close();

    const second = new SQLiteSemanticMemoryProvider(path, fakeEmbeddings());
    const results = await second.recall({ resourceId: "user-1" }, "cat");
    expect(results).toHaveLength(1);
    second.close();

    // Best-effort cleanup — on Windows the OS can hold the file handle open briefly after
    // `close()` returns, so a failed rm here is a leaked temp file, not a test failure.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${path}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
  });
});

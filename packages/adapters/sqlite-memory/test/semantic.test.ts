import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
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

  it("ranks by cosine distance, not sqlite-vec's L2 default", async () => {
    // Constructed so L2 and cosine disagree on which fact is "closer" to the query, so this
    // only passes if the native vec0 index was actually created with distance_metric=cosine:
    // "off-direction" is nearer to the query in raw Euclidean distance (~0.89) than
    // "aligned-large-magnitude" (~4), but perfectly aligned in *direction* with the query
    // (cosine distance 0 vs ~0.4) — the same direction @alineo-labs/postgres-memory's
    // vector_cosine_ops HNSW index and InMemorySemanticMemoryProvider's cosineSimilarity()
    // would rank it, since every provider in this family must agree on ranking for
    // "provider-agnostic" to mean anything.
    const vectors: Record<string, number[]> = {
      query: [1, 0],
      "off-direction": [0.6, 0.8],
      "aligned-large-magnitude": [5, 0],
    };
    const fixedEmbeddings: EmbeddingProvider = {
      id: "fixed",
      async embed(texts) {
        return texts.map((t) => vectors[t] ?? [0, 0]);
      },
    };
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fixedEmbeddings);
    const ref = { resourceId: "user-1" };
    await provider.remember(ref, { content: "off-direction" });
    await provider.remember(ref, { content: "aligned-large-magnitude" });

    expect(provider.hasVectorIndex).toBe(true);
    const results = await provider.recall(ref, "query", { topK: 1 });

    expect(results[0]?.content).toBe("aligned-large-magnitude");
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

  it("marks a fact with a sourceRef as verified, and a free-form fact as unverified", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    await provider.remember(ref, {
      content: "cat fact with source",
      sourceRef: { sandboxId: "sb-1", entryIndex: 0 },
    });
    await provider.remember(ref, { content: "cat fact without source" });

    const all = await provider.listAll(ref);

    expect(all.find((f) => f.content.includes("with source"))?.verified).toBe(true);
    expect(all.find((f) => f.content.includes("without source"))?.verified).toBe(false);
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

  describe("rememberMany", () => {
    it("batches the embedding call into one embed() invocation for all facts", async () => {
      const calls: string[][] = [];
      const embeddings: EmbeddingProvider = {
        id: "counting-fake",
        async embed(texts) {
          calls.push(texts);
          return texts.map((t) => (t.toLowerCase().includes("cat") ? [1, 0] : [0, 1]));
        },
      };
      const provider = new SQLiteSemanticMemoryProvider(":memory:", embeddings);
      const ref = { resourceId: "user-1" };

      await provider.rememberMany(ref, [
        { content: "cat fact one" },
        { content: "dog fact one" },
        { content: "cat fact two" },
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["cat fact one", "dog fact one", "cat fact two"]);
      const all = await provider.listAll(ref);
      expect(all.map((f) => f.content).sort()).toEqual(
        ["cat fact one", "cat fact two", "dog fact one"].sort(),
      );
      provider.close();
    });

    it("recall() finds facts written via rememberMany, through the native vec0 index", async () => {
      const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
      const ref = { resourceId: "user-1" };

      await provider.rememberMany(ref, [
        { content: "cat fact A" },
        { content: "dog fact A" },
        { content: "cat fact B" },
      ]);

      expect(provider.hasVectorIndex).toBe(true);
      const results = await provider.recall(ref, "cat", { topK: 2 });
      expect(results).toHaveLength(2);
      expect(results.every((f) => f.content.includes("cat"))).toBe(true);
      provider.close();
    });

    it("isolates facts written via rememberMany between resources", async () => {
      const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
      await provider.rememberMany({ resourceId: "user-1" }, [{ content: "cat fact" }]);

      expect(await provider.recall({ resourceId: "user-2" }, "cat")).toEqual([]);
      provider.close();
    });

    it("is a no-op for an empty facts array", async () => {
      const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
      await provider.rememberMany({ resourceId: "user-1" }, []);

      expect(await provider.listAll({ resourceId: "user-1" })).toEqual([]);
      provider.close();
    });
  });
});

describe("SQLiteSemanticMemoryProvider.listRecent", () => {
  it("returns the newest facts first and stops at the limit", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    for (const content of ["first", "second", "third", "fourth"]) {
      await provider.remember(ref, { content });
      await Bun.sleep(3); // distinct remembered_at
    }
    await provider.remember({ resourceId: "someone-else" }, { content: "not mine" });

    expect((await provider.listRecent(ref, 2)).map((f) => f.content)).toEqual(["fourth", "third"]);
    expect(await provider.listRecent(ref, 0)).toEqual([]);
    expect((await provider.listRecent(ref, 100)).map((f) => f.content)).toEqual([
      "fourth",
      "third",
      "second",
      "first",
    ]);
    provider.close();
  });

  it("breaks a same-millisecond tie by insertion order, newest first", async () => {
    const provider = new SQLiteSemanticMemoryProvider(":memory:", fakeEmbeddings());
    const ref = { resourceId: "user-1" };
    const realNow = Date.now;
    Date.now = () => 1_000; // every fact lands in the same millisecond
    try {
      for (const content of ["a", "b", "c"]) await provider.remember(ref, { content });
    } finally {
      Date.now = realNow;
    }
    expect((await provider.listRecent(ref, 3)).map((f) => f.content)).toEqual(["c", "b", "a"]);
    provider.close();
  });
});

describe("SQLiteSemanticMemoryProvider embedding dimensions", () => {
  const sized = (n: number): EmbeddingProvider => ({
    id: `dim-${n}`,
    async embed(texts) {
      return texts.map(() => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0)));
    },
  });
  const ref = { resourceId: "user-1" };
  /** The message a promise rejects with, or "" if it resolved. */
  const failure = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => "",
      (e: Error) => e.message,
    );

  function tmpFile(): string {
    return join(mkdtempSync(join(tmpdir(), "sqlite-memory-dim-")), "memory.db");
  }

  it("refuses a different-width embedding model on an existing store — before writing anything", async () => {
    const path = tmpFile();
    const first = new SQLiteSemanticMemoryProvider(path, sized(3));
    await first.remember(ref, { content: "stored with a 3-dim model" });
    first.close();

    // A restart with a different model: this instance's own idea of the width starts out empty,
    // so only the table on disk can say it's wrong.
    const second = new SQLiteSemanticMemoryProvider(path, sized(5));
    expect(await failure(second.remember(ref, { content: "a 5-dim fact" }))).toMatch(
      /3-dimensional embeddings but this embedding model produced 5/,
    );
    expect(await failure(second.rememberMany(ref, [{ content: "another" }]))).toMatch(
      /3-dimensional/,
    );

    // Nothing half-written: no metadata row without its vector, and the index never claimed to work.
    expect((await second.listAll(ref)).map((f) => f.content)).toEqual([
      "stored with a 3-dim model",
    ]);
    expect(second.hasVectorIndex).toBe(false);
    second.close();
  });

  it("is still happy to reopen with the same model, and recall still works", async () => {
    const path = tmpFile();
    const first = new SQLiteSemanticMemoryProvider(path, sized(4));
    await first.remember(ref, { content: "kept" });
    first.close();

    const again = new SQLiteSemanticMemoryProvider(path, sized(4));
    await again.remember(ref, { content: "added after restart" });
    expect(again.hasVectorIndex).toBe(true);
    expect((await again.recall(ref, "anything", { topK: 5 })).length).toBe(2);
    again.close();
  });

  it("catches a model that changes width within one process too", async () => {
    let n = 3;
    const shifty: EmbeddingProvider = {
      id: "shifty",
      embed: async (texts) => texts.map(() => Array.from({ length: n }, () => 1)),
    };
    const provider = new SQLiteSemanticMemoryProvider(":memory:", shifty);
    await provider.remember(ref, { content: "first" });
    n = 6;
    expect(await failure(provider.remember(ref, { content: "second" }))).toMatch(/3-dimensional/);
    expect((await provider.listAll(ref)).length).toBe(1);
    provider.close();
  });
});

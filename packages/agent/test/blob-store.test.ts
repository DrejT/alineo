import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBlobStore, S3BlobStore, type S3ClientLike } from "../src/blob-store";

/** A bucket in a Map that answers the way S3 does, including paged listings. */
function fakeS3(pageSize = 1000) {
  const objects = new Map<string, { bytes: Uint8Array; lastModified: string }>();
  const writes: string[] = [];
  const client: S3ClientLike = {
    file: (key) => ({
      write: (data) => {
        writes.push(key);
        return (async () => {
          const bytes =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : data instanceof Uint8Array
                ? data
                : new Uint8Array(await data.arrayBuffer());
          objects.set(key, { bytes, lastModified: "2026-10-18T00:00:00.000Z" });
          return bytes.length;
        })();
      },
      bytes: () => {
        const hit = objects.get(key);
        return hit ? Promise.resolve(hit.bytes) : Promise.reject(new Error(`NoSuchKey: ${key}`));
      },
    }),
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix = "", continuationToken }) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = continuationToken ? Number(continuationToken) : 0;
      const page = keys.slice(start, start + pageSize);
      const more = start + pageSize < keys.length;
      return Promise.resolve({
        contents: page.map((key) => ({ key, lastModified: objects.get(key)!.lastModified })),
        isTruncated: more,
        nextContinuationToken: more ? String(start + pageSize) : undefined,
      });
    },
  };
  return { client, objects, writes };
}

describe("S3BlobStore", () => {
  it("writes under its prefix and reads the same bytes back", async () => {
    const { client, objects } = fakeS3();
    const store = new S3BlobStore({ bucket: "b", prefix: "/alineod/main/", client });

    await store.put("sb-1/1-100.tar.gz", new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));

    expect([...objects.keys()]).toEqual(["alineod/main/sb-1/1-100.tar.gz"]);
    expect([...(await store.get("sb-1/1-100.tar.gz"))]).toEqual([0x1f, 0x8b, 0x00, 0xff]);
  });

  it("uploads a local file by path", async () => {
    const { client, objects } = fakeS3();
    const store = new S3BlobStore({ bucket: "b", client });
    const dir = mkdtempSync(join(tmpdir(), "blob-test-"));
    const file = join(dir, "x.tar.gz");
    writeFileSync(file, "tarball-bytes");

    await store.put("k", file);

    expect(new TextDecoder().decode(objects.get("k")!.bytes)).toBe("tarball-bytes");
  });

  it("turns a key into a reference and back, and does not claim another store's reference", () => {
    const store = new S3BlobStore({ bucket: "b", prefix: "p/i", client: fakeS3().client });

    expect(store.refOf("sb/1.tar.gz")).toBe("s3://b/p/i/sb/1.tar.gz");
    expect(store.keyOf("s3://b/p/i/sb/1.tar.gz")).toBe("sb/1.tar.gz");
    expect(store.keyOf("s3://other/p/i/sb/1.tar.gz")).toBeUndefined();
    expect(store.keyOf("s3://b/p/other/sb/1.tar.gz")).toBeUndefined();
    expect(store.keyOf("/host/path/1.tar.gz")).toBeUndefined();
  });

  it("works without a prefix", () => {
    const store = new S3BlobStore({ bucket: "b", client: fakeS3().client });
    expect(store.refOf("k")).toBe("s3://b/k");
    expect(store.keyOf("s3://b/k")).toBe("k");
  });

  it("lists keys relative to the store, across pages, with their times", async () => {
    const { client } = fakeS3(2);
    const store = new S3BlobStore({ bucket: "b", prefix: "p", client });
    for (const k of ["sb-1/a", "sb-1/b", "sb-1/c", "sb-2/a"]) await store.put(k, new Uint8Array(1));

    const listed = await store.list("sb-1/");

    expect(listed.map((b) => b.key).sort()).toEqual(["sb-1/a", "sb-1/b", "sb-1/c"]);
    expect(listed[0]!.lastModified).toBe(Date.parse("2026-10-18T00:00:00.000Z"));
  });

  it("deletes a key", async () => {
    const { client, objects } = fakeS3();
    const store = new S3BlobStore({ bucket: "b", client });
    await store.put("k", new Uint8Array(1));

    await store.delete("k");

    expect(objects.size).toBe(0);
  });
});

describe("MemoryBlobStore", () => {
  it("round-trips bytes without sharing the caller's buffer", async () => {
    const store = new MemoryBlobStore();
    const input = new Uint8Array([1, 2, 3]);
    await store.put("k", input);
    input[0] = 9;

    expect([...(await store.get("k"))]).toEqual([1, 2, 3]);
  });

  it("rejects a missing key", async () => {
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types `.rejects` as void
    await expect(new MemoryBlobStore().get("nope")).rejects.toThrow(/no such blob/);
  });

  it("ages blobs by the clock it was given", async () => {
    let now = 1_000;
    const store = new MemoryBlobStore(() => now);
    await store.put("a", new Uint8Array(1));
    now = 5_000;
    await store.put("b", new Uint8Array(1));

    const listed = await store.list("");

    expect(Object.fromEntries(listed.map((b) => [b.key, b.lastModified]))).toEqual({
      a: 1_000,
      b: 5_000,
    });
  });

  it("owns only its own references", () => {
    const store = new MemoryBlobStore();
    expect(store.keyOf(store.refOf("a/b"))).toBe("a/b");
    expect(store.keyOf("s3://b/a/b")).toBeUndefined();
  });
});

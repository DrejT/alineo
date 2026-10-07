import { rmSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { SQLiteWorkingMemoryProvider } from "../src/working.ts";

describe("SQLiteWorkingMemoryProvider", () => {
  it("stores and retrieves a value scoped by resourceId", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    const ref = { resourceId: "user-1" };

    await provider.set(ref, "favoriteColor", "blue");

    expect(await provider.get(ref, "favoriteColor")).toBe("blue");
    provider.close();
  });

  it("persists structured (non-string) values via JSON round-trip", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    const ref = { resourceId: "user-1" };

    await provider.set(ref, "prefs", { theme: "dark", count: 3 });

    expect(await provider.get(ref, "prefs")).toEqual({ theme: "dark", count: 3 });
    provider.close();
  });

  it("returns undefined for a key that was never set", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    expect(await provider.get({ resourceId: "user-1" }, "missing")).toBeUndefined();
    provider.close();
  });

  it("isolates values between different resourceIds", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    await provider.set({ resourceId: "user-1" }, "key", "a");
    await provider.set({ resourceId: "user-2" }, "key", "b");

    expect(await provider.get({ resourceId: "user-1" }, "key")).toBe("a");
    expect(await provider.get({ resourceId: "user-2" }, "key")).toBe("b");
    provider.close();
  });

  it("overwrites an existing key on set (upsert)", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    const ref = { resourceId: "user-1" };
    await provider.set(ref, "key", "first");
    await provider.set(ref, "key", "second");

    expect(await provider.get(ref, "key")).toBe("second");
    provider.close();
  });

  it("lists all keys for a resource", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    const ref = { resourceId: "user-1" };
    await provider.set(ref, "a", 1);
    await provider.set(ref, "b", 2);

    expect(await provider.list(ref)).toEqual({ a: 1, b: 2 });
    provider.close();
  });

  it("deletes a key", async () => {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    const ref = { resourceId: "user-1" };
    await provider.set(ref, "key", "value");

    await provider.delete(ref, "key");

    expect(await provider.get(ref, "key")).toBeUndefined();
    provider.close();
  });

  it("survives being reopened against the same file (real persistence)", async () => {
    const path = `${import.meta.dir}/.tmp-working-${crypto.randomUUID()}.db`;
    const first = new SQLiteWorkingMemoryProvider(path);
    await first.set({ resourceId: "user-1" }, "key", "value");
    first.close();

    const second = new SQLiteWorkingMemoryProvider(path);
    expect(await second.get({ resourceId: "user-1" }, "key")).toBe("value");
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

describe("SQLiteWorkingMemoryProvider.listPage", () => {
  const ref = { resourceId: "user-1" };

  async function seeded(keys: string[]) {
    const provider = new SQLiteWorkingMemoryProvider(":memory:");
    for (const k of keys) await provider.set(ref, k, `v-${k}`);
    await provider.set({ resourceId: "someone-else" }, "zzz-not-mine", 1);
    return provider;
  }

  it("returns one page in ascending key order, and says whether more follow", async () => {
    const provider = await seeded(["d", "b", "a", "c", "e"]);

    const first = await provider.listPage(ref, { limit: 2 });
    expect(first.entries).toEqual([
      ["a", "v-a"],
      ["b", "v-b"],
    ]);
    expect(first.more).toBe(true);

    const second = await provider.listPage(ref, { after: "b", limit: 2 });
    expect(second.entries.map(([k]) => k)).toEqual(["c", "d"]);
    expect(second.more).toBe(true);

    const last = await provider.listPage(ref, { after: "d", limit: 2 });
    expect(last.entries.map(([k]) => k)).toEqual(["e"]);
    expect(last.more).toBe(false);
    provider.close();
  });

  it("an exactly-full last page is not followed by a phantom one", async () => {
    const provider = await seeded(["a", "b"]);
    expect((await provider.listPage(ref, { limit: 2 })).more).toBe(false);
    provider.close();
  });

  it("orders by UTF-8 bytes, and keeps integer-like keys in that order too", async () => {
    // As a list of pairs the order survives; as an object, "9" would jump ahead of "10".
    const provider = await seeded(["9", "10", "😀", "￿", "é", "Z"]);
    const { entries } = await provider.listPage(ref, { limit: 10 });
    expect(entries.map(([k]) => k)).toEqual(["10", "9", "Z", "é", "￿", "😀"]);
    provider.close();
  });

  it("an empty resource, a limit of 0, and a cursor past the end are all just empty", async () => {
    const provider = await seeded(["a"]);
    expect(await provider.listPage({ resourceId: "nobody" }, { limit: 5 })).toEqual({
      entries: [],
      more: false,
    });
    expect((await provider.listPage(ref, { limit: 0 })).entries).toEqual([]);
    expect(await provider.listPage(ref, { after: "zzz", limit: 5 })).toEqual({
      entries: [],
      more: false,
    });
    provider.close();
  });
});

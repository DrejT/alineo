import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

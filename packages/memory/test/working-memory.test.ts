import { describe, expect, it } from "vitest";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";
import type { ResourceRef } from "../src/types.ts";

describe("InMemoryWorkingMemoryProvider", () => {
  it("stores and retrieves a value scoped by resourceId", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    const ref: ResourceRef = { resourceId: "user-1" };

    await provider.set(ref, "favoriteColor", "blue");

    expect(await provider.get(ref, "favoriteColor")).toBe("blue");
  });

  it("returns undefined for a key that was never set", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    expect(await provider.get({ resourceId: "user-1" }, "missing")).toBeUndefined();
  });

  it("isolates values between different resourceIds", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    await provider.set({ resourceId: "user-1" }, "key", "a");
    await provider.set({ resourceId: "user-2" }, "key", "b");

    expect(await provider.get({ resourceId: "user-1" }, "key")).toBe("a");
    expect(await provider.get({ resourceId: "user-2" }, "key")).toBe("b");
  });

  it("isolates values between the same resourceId under different teams", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    await provider.set({ resourceId: "res-1", teamId: "team-a" }, "key", "a");
    await provider.set({ resourceId: "res-1", teamId: "team-b" }, "key", "b");
    await provider.set({ resourceId: "res-1" }, "key", "no-team");

    expect(await provider.get({ resourceId: "res-1", teamId: "team-a" }, "key")).toBe("a");
    expect(await provider.get({ resourceId: "res-1", teamId: "team-b" }, "key")).toBe("b");
    expect(await provider.get({ resourceId: "res-1" }, "key")).toBe("no-team");
  });

  it("lists all keys for a resource", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    const ref: ResourceRef = { resourceId: "user-1" };
    await provider.set(ref, "a", 1);
    await provider.set(ref, "b", 2);

    expect(await provider.list(ref)).toEqual({ a: 1, b: 2 });
  });

  it("returns an empty object when listing an unknown resource", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    expect(await provider.list({ resourceId: "never-set" })).toEqual({});
  });

  it("deletes a key", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    const ref: ResourceRef = { resourceId: "user-1" };
    await provider.set(ref, "key", "value");

    await provider.delete(ref, "key");

    expect(await provider.get(ref, "key")).toBeUndefined();
  });

  it("deleting an unknown key on an unknown resource is a no-op", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    await expect(provider.delete({ resourceId: "never-set" }, "key")).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { SchemaWorkingMemory } from "../src/schema-working-memory.ts";
import type { SchemaValidator } from "../src/schema-working-memory.ts";
import { InMemoryWorkingMemoryProvider } from "../src/working.ts";
import type { ResourceRef } from "../src/types.ts";

interface Profile {
  name?: string;
  preferredLanguage?: string;
  age?: number;
}

/** Hand-rolled validator — proves the interface needs nothing more than `.parse()`, no
 * concrete schema library required. */
function profileValidator(): SchemaValidator<Profile> {
  return {
    parse(data) {
      // SAFETY: `parse`'s whole job is inspecting unparsed `data` field-by-field below; this
      // is the validation boundary itself, not a place that assumes shape without checking it.
      const obj = data as Record<string, unknown>;

      if (obj.name !== undefined && typeof obj.name !== "string") {
        throw new Error("name must be a string");
      }

      if (obj.age !== undefined && typeof obj.age !== "number") {
        throw new Error("age must be a number");
      }

      return obj;
    },
  };
}

const ref: ResourceRef = { resourceId: "user-1" };

describe("SchemaWorkingMemory", () => {
  it("returns an empty object before anything is set", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    expect(await profile.get(ref)).toEqual({});
  });

  it("update() validates and persists the merged profile", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    const result = await profile.update(ref, { name: "Ada" });

    expect(result).toEqual({ name: "Ada" });
    expect(await profile.get(ref)).toEqual({ name: "Ada" });
  });

  it("update() merges with the existing profile rather than replacing it", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    await profile.update(ref, { name: "Ada" });

    await profile.update(ref, { preferredLanguage: "TypeScript" });

    expect(await profile.get(ref)).toEqual({ name: "Ada", preferredLanguage: "TypeScript" });
  });

  it("update() throws on invalid input and does not persist it", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    await profile.update(ref, { name: "Ada" });

    // SAFETY: simulates a caller passing unparsed external input past the type system --
    // the cast doesn't claim `age` is really a number, it's exactly the bad shape update()'s
    // own runtime validator (profileValidator() above) must catch and reject.
    await expect(
      profile.update(ref, JSON.parse('{"age":"not a number"}') as Partial<Profile>),
    ).rejects.toThrow("age must be a number");
    expect(await profile.get(ref)).toEqual({ name: "Ada" });
  });

  it("isolates profiles between different resourceIds", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    await profile.update({ resourceId: "user-1" }, { name: "Ada" });
    await profile.update({ resourceId: "user-2" }, { name: "Grace" });

    expect(await profile.get({ resourceId: "user-1" })).toEqual({ name: "Ada" });
    expect(await profile.get({ resourceId: "user-2" })).toEqual({ name: "Grace" });
  });

  it("clear() removes the stored profile", async () => {
    const profile = new SchemaWorkingMemory(
      new InMemoryWorkingMemoryProvider(),
      profileValidator(),
    );

    await profile.update(ref, { name: "Ada" });

    await profile.clear(ref);

    expect(await profile.get(ref)).toEqual({});
  });

  it("uses a custom key when given one", async () => {
    const provider = new InMemoryWorkingMemoryProvider();
    const profile = new SchemaWorkingMemory(provider, profileValidator(), "customProfileKey");

    await profile.update(ref, { name: "Ada" });

    expect(await provider.get(ref, "customProfileKey")).toEqual({ name: "Ada" });
    expect(await provider.get(ref, "__profile")).toBeUndefined();
  });
});

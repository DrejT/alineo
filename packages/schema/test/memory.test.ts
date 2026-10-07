import { describe, expect, it, vi } from "vitest";
import { MEMORY_VALUE_MAX_BYTES, MemoryValueBody } from "../src/alineod";
import { resourceRefOf } from "../src/index";

describe("resourceRefOf", () => {
  it("scopes by resourceId, defaulting to the spec's name", () => {
    expect(resourceRefOf({ name: "billing" })).toEqual({ resourceId: "billing" });
    expect(resourceRefOf({ name: "billing", resourceId: "acct-7" })).toEqual({
      resourceId: "acct-7",
    });
  });

  it("carries teamId only when the spec has one", () => {
    expect(resourceRefOf({ name: "a", teamId: "t" })).toEqual({ resourceId: "a", teamId: "t" });
    expect(resourceRefOf({ name: "a" })).not.toHaveProperty("teamId");
  });

  it("an explicitly set resourceId wins even when falsy — `??`, not `||`", () => {
    expect(resourceRefOf({ name: "a", resourceId: "" }).resourceId).toBe("");
  });
});

describe("MemoryValueBody", () => {
  const issues = (body: unknown) => {
    const r = MemoryValueBody.safeParse(body);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("accepts any JSON value, including falsy ones", () => {
    for (const value of [0, false, "", null, [], {}, { a: [1, { b: 2 }] }]) {
      expect(issues({ value })).toEqual([]);
    }
  });

  it("requires the value", () => {
    expect(issues({})).toEqual(["value is required"]);
  });

  it("rejects what JSON can't carry", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(issues({ value: circular })).toEqual(["value must be JSON-serializable"]);
    expect(issues({ value: () => 1 })).toEqual(["value must be JSON-serializable"]);
    expect(issues({ value: 10n })).toEqual(["value must be JSON-serializable"]);
  });

  it("enforces the size cap on the serialized bytes — multi-byte characters count as bytes", () => {
    expect(issues({ value: "x".repeat(MEMORY_VALUE_MAX_BYTES - 2) })).toEqual([]); // + 2 quotes
    expect(issues({ value: "x".repeat(MEMORY_VALUE_MAX_BYTES - 1) })).toEqual([
      `value must be at most ${MEMORY_VALUE_MAX_BYTES} bytes as JSON`,
    ]);
    // 3 bytes each: well under the cap in characters, over it in bytes.
    expect(issues({ value: "€".repeat(MEMORY_VALUE_MAX_BYTES / 3) })).toHaveLength(1);
  });

  it("serializes the value once, not once per check", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      MemoryValueBody.safeParse({ value: { a: 1 } });
      // The parse itself isn't `JSON.stringify`; only the value check is.
      const calls = spy.mock.calls.filter(([v]) => (v as { a?: number })?.a === 1);
      expect(calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

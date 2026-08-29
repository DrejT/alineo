import { describe, expect, it } from "vitest";
import { scopeKey } from "../src/types.ts";

describe("scopeKey", () => {
  it("returns the plain resourceId when no teamId is set", () => {
    expect(scopeKey({ resourceId: "user-1" })).toBe("user-1");
  });

  it("joins teamId and resourceId with a colon", () => {
    expect(scopeKey({ resourceId: "corp", teamId: "acme" })).toBe("acme:corp");
  });

  it("does not let an untenanted resourceId collide with a tenanted team/resource pair", () => {
    // Before escaping, both of these produced the identical string "acme:corp" — a real
    // cross-tenant collision, not just a naming curiosity, since access-control.ts skips its
    // check entirely for a ref with no teamId.
    const untenanted = scopeKey({ resourceId: "acme:corp" });
    const tenanted = scopeKey({ resourceId: "corp", teamId: "acme" });
    expect(untenanted).not.toBe(tenanted);
  });

  it("does not let a resourceId containing an escape sequence collide with a different pair", () => {
    const a = scopeKey({ resourceId: "acme\\:corp" });
    const b = scopeKey({ resourceId: "corp", teamId: "acme" });
    expect(a).not.toBe(b);
  });

  it("is injective — distinct refs never produce the same key", () => {
    const refs = [
      { resourceId: "acme:corp" },
      { resourceId: "corp", teamId: "acme" },
      { resourceId: "acme\\:corp" },
      { resourceId: "acme\\", teamId: "corp" },
      { resourceId: "corp", teamId: "acme\\" },
      { resourceId: "plain" },
    ];
    const keys = refs.map(scopeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

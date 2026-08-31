import { describe, it, expect } from "bun:test";
import { normalizePermissions, evaluatePolicy, READ_ONLY_TOOLS } from "../src/permissions";

describe("normalizePermissions", () => {
  it("returns undefined for unset or 'auto' (no gate)", () => {
    expect(normalizePermissions(undefined)).toBeUndefined();
    expect(normalizePermissions("auto")).toBeUndefined();
  });

  it("'ask' → default ask, no rules", () => {
    expect(normalizePermissions("ask")).toEqual({ default: "ask", rules: [], disabledTools: [] });
  });

  it("'readonly' → ask by default, allow the read tools", () => {
    const p = normalizePermissions("readonly");
    expect(p?.default).toBe("ask");
    expect(p?.rules.map((r) => r.tool).sort()).toEqual([...READ_ONLY_TOOLS].sort());
    expect(p?.rules.every((r) => r.action === "allow")).toBe(true);
  });

  it("fills defaults on a partial policy object", () => {
    expect(normalizePermissions({ rules: [{ tool: "bash", action: "deny" }] })).toEqual({
      default: "ask",
      rules: [{ tool: "bash", action: "deny" }],
      disabledTools: [],
    });
  });

  it("keeps an explicit default and disabledTools", () => {
    const p = normalizePermissions({ default: "allow", disabledTools: ["bash"] });
    expect(p).toEqual({ default: "allow", rules: [], disabledTools: ["bash"] });
  });
});

describe("evaluatePolicy", () => {
  const P = (over: Partial<ReturnType<typeof normalizePermissions>> = {}) => ({
    default: "ask" as const,
    rules: [],
    disabledTools: [],
    ...over,
  });

  it("falls back to the policy default when nothing matches", () => {
    expect(evaluatePolicy(P(), "bash", "ls").action).toBe("ask");
    expect(evaluatePolicy(P({ default: "allow" }), "bash", "ls").action).toBe("allow");
  });

  it("matches a rule by tool name", () => {
    const p = P({ rules: [{ tool: "read", action: "allow" }] });
    expect(evaluatePolicy(p, "read", "/etc/hosts").action).toBe("allow");
    expect(evaluatePolicy(p, "write", "/etc/hosts").action).toBe("ask");
  });

  it("last matching rule wins", () => {
    const p = P({
      rules: [
        { tool: "bash", action: "deny" },
        { tool: "bash", pattern: "git *", action: "allow" },
      ],
    });
    expect(evaluatePolicy(p, "bash", "git status").action).toBe("allow");
    expect(evaluatePolicy(p, "bash", "rm -rf /").action).toBe("deny");
  });

  it("anchors glob patterns, supports * and ?", () => {
    const p = P({ rules: [{ tool: "bash", pattern: "rm -rf *", action: "deny" }] });
    expect(evaluatePolicy(p, "bash", "rm -rf node_modules").action).toBe("deny");
    expect(evaluatePolicy(p, "bash", "echo rm -rf x").action).toBe("ask"); // not anchored → no match
  });

  it("substring match via *pattern*", () => {
    const p = P({ rules: [{ tool: "bash", pattern: "*sudo*", action: "deny" }] });
    expect(evaluatePolicy(p, "bash", "echo x && sudo rm").action).toBe("deny");
  });

  it("tool globs work too", () => {
    const p = P({ rules: [{ tool: "*", action: "allow" }] });
    expect(evaluatePolicy(p, "anything", "").action).toBe("allow");
  });

  it("disabledTools short-circuits to deny regardless of rules", () => {
    const p = P({ disabledTools: ["bash"], rules: [{ tool: "bash", action: "allow" }] });
    expect(evaluatePolicy(p, "bash", "ls").action).toBe("deny");
  });

  it("returns the matched rule (for rate_limit bookkeeping)", () => {
    const rule = {
      tool: "bash",
      action: "rate_limit" as const,
      limit: { count: 3, windowMs: 1000 },
    };
    expect(evaluatePolicy(P({ rules: [rule] }), "bash", "x").rule).toEqual(rule);
  });
});

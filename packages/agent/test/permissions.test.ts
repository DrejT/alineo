import { describe, it, expect } from "bun:test";
import {
  normalizePermissions,
  evaluatePolicy,
  isReadOnlyBashCommand,
  READ_ONLY_TOOLS,
} from "../src/permissions";

describe("normalizePermissions", () => {
  it("returns undefined for unset or 'auto' (no gate)", () => {
    expect(normalizePermissions(undefined)).toBeUndefined();
    expect(normalizePermissions("auto")).toBeUndefined();
  });

  it("'ask' → default ask, no rules", () => {
    expect(normalizePermissions("ask")).toEqual({
      default: "ask",
      rules: [],
      disabledTools: [],
      restrictToTools: [],
    });
  });

  it("'readonly' → ask by default, allow the read tools, classify bash, restrict the toolset", () => {
    const p = normalizePermissions("readonly");
    expect(p?.default).toBe("ask");
    expect(p?.restrictToTools.slice().sort()).toEqual([...READ_ONLY_TOOLS].sort());
    expect(
      p?.rules
        .filter((r) => r.action === "allow")
        .map((r) => r.tool)
        .sort(),
    ).toEqual([...READ_ONLY_TOOLS].sort());
    expect(p?.rules.some((r) => r.tool === "bash" && r.action === "classify")).toBe(true);
  });

  it("fills defaults on a partial policy object", () => {
    expect(normalizePermissions({ rules: [{ tool: "bash", action: "deny" }] })).toEqual({
      default: "ask",
      rules: [{ tool: "bash", action: "deny" }],
      disabledTools: [],
      restrictToTools: [],
    });
  });

  it("keeps an explicit default, disabledTools, and restrictToTools", () => {
    const p = normalizePermissions({
      default: "allow",
      disabledTools: ["bash"],
      restrictToTools: ["read", "grep"],
    });
    expect(p).toEqual({
      default: "allow",
      rules: [],
      disabledTools: ["bash"],
      restrictToTools: ["read", "grep"],
    });
  });
});

describe("evaluatePolicy", () => {
  const P = (over: Partial<ReturnType<typeof normalizePermissions>> = {}) => ({
    default: "ask" as const,
    rules: [],
    disabledTools: [],
    restrictToTools: [],
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

  it("'classify' resolves to allow for a read-only bash command, ask otherwise", () => {
    const p = P({ rules: [{ tool: "bash", action: "classify" }] });
    expect(evaluatePolicy(p, "bash", "ls -la && cat README.md").action).toBe("allow");
    expect(evaluatePolicy(p, "bash", "git status").action).toBe("allow");
    expect(evaluatePolicy(p, "bash", "rm -rf build").action).toBe("ask");
    expect(evaluatePolicy(p, "bash", "echo hi > out.txt").action).toBe("ask");
  });

  it("'classify' on a non-bash tool just asks", () => {
    const p = P({ rules: [{ tool: "write", action: "classify" }] });
    expect(evaluatePolicy(p, "write", "/tmp/x").action).toBe("ask");
  });
});

describe("isReadOnlyBashCommand", () => {
  it("recognises pure readers and pipelines of them", () => {
    expect(isReadOnlyBashCommand("ls")).toBe(true);
    expect(isReadOnlyBashCommand("cat a.txt | grep foo | wc -l")).toBe(true);
    expect(isReadOnlyBashCommand("git log --oneline -5 && git diff")).toBe(true);
    expect(isReadOnlyBashCommand("FOO=bar env")).toBe(true);
    expect(isReadOnlyBashCommand("timeout 5 grep -r foo .")).toBe(true);
  });

  it("flags writers, redirects, unknowns", () => {
    expect(isReadOnlyBashCommand("rm file")).toBe(false);
    expect(isReadOnlyBashCommand("echo hi > f")).toBe(false);
    expect(isReadOnlyBashCommand("cat a && npm install")).toBe(false);
    expect(isReadOnlyBashCommand("git push")).toBe(false);
    expect(isReadOnlyBashCommand("curl https://x.test")).toBe(false);
    expect(isReadOnlyBashCommand("")).toBe(false);
  });

  it("allows benign stderr redirects", () => {
    expect(isReadOnlyBashCommand("grep foo bar 2>/dev/null")).toBe(true);
    expect(isReadOnlyBashCommand("ls 2>&1")).toBe(true);
  });
});

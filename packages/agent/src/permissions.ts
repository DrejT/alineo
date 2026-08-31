/**
 * Human-in-the-loop tool-call policy — the host-side half.
 *
 * `AgentSpec.permissions` (a mode string or a full policy) is normalized here into a
 * `NormalizedPermissionPolicy`, written into the sandbox at `/etc/alineo-pi.json`, and read
 * by the bundled Pi gate extension (`adapters/pi-permission-gate.js`), which re-implements
 * the tiny matcher below inline (same duplication tradeoff `pi-bridge.js` already makes —
 * the gate can't import from a published package it runs beside via jiti). Keep the two
 * matchers in sync; `test/permissions.test.ts` covers this one.
 */

/**
 * Shorthand for the common cases:
 * - `"auto"` — never ask (the default; identical to not setting `permissions` at all)
 * - `"ask"` — ask before every tool call
 * - `"readonly"` — auto-allow the read-only tools (`read`/`grep`/`find`/`ls`), ask before
 *   `write`/`edit`/`bash`/`powershell`. Pi has no network tool — an agent reaches the
 *   network through `bash`, so `"readonly"` gates that by gating `bash`, not as a category.
 */
export type PermissionMode = "auto" | "ask" | "readonly";

/**
 * What happens when a rule (or the policy default) matches a tool call:
 * - `allow` — run it, no prompt
 * - `ask` — pause, surface a `permission_request`, wait for a human decision
 * - `deny` — refuse, with a reason the model reads and can adjust to
 * - `rate_limit` — allow up to `limit.count` matching calls per `limit.windowMs`, then deny
 */
export type PermissionAction = "allow" | "ask" | "deny" | "rate_limit";

export interface PermissionRule {
  /** Tool name or glob (`*` = any run of chars, `?` = one), e.g. `"bash"`, `"write"`, `"*"`. */
  tool: string;
  /**
   * Glob matched against a tool-specific target string, extracted from Pi's typed
   * `event.input` — the command for `bash`, the path for `read`/`write`/`edit`, the query
   * for `grep`. Anchored: `"git *"` matches `"git status"` but not `"x && git status"` —
   * use `"*git*"` for a substring match. Omit to match any call to `tool`.
   */
  pattern?: string;
  action: PermissionAction;
  /** `rate_limit` only: the ceiling and rolling window. */
  limit?: { count: number; windowMs: number };
}

export interface PermissionPolicy {
  /** Action when no rule matches. Default `"ask"`. */
  default?: PermissionAction;
  /** Evaluated in order; the **last** matching rule wins (opencode semantics). */
  rules?: PermissionRule[];
  /**
   * Tools the agent may never call. Enforced today as an unconditional `deny` with a clear
   * reason (a stricter "hidden from the model entirely" mode is a later refinement).
   */
  disabledTools?: string[];
}

/** The fully-defaulted shape written to `/etc/alineo-pi.json` and read by the gate. */
export interface NormalizedPermissionPolicy {
  default: PermissionAction;
  rules: PermissionRule[];
  disabledTools: string[];
}

/** Read-only built-in tools — auto-allowed under `"readonly"`. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

function expandMode(mode: PermissionMode): NormalizedPermissionPolicy | undefined {
  switch (mode) {
    case "auto":
      return undefined; // no gate loaded at all
    case "ask":
      return { default: "ask", rules: [], disabledTools: [] };
    case "readonly":
      return {
        default: "ask",
        rules: READ_ONLY_TOOLS.map((tool) => ({ tool, action: "allow" as const })),
        disabledTools: [],
      };
  }
}

/**
 * Turn `AgentSpec.permissions` into the normalized policy the gate consumes, or `undefined`
 * when no gate is needed (unset, or `"auto"`).
 */
export function normalizePermissions(
  input: PermissionMode | PermissionPolicy | undefined,
): NormalizedPermissionPolicy | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return expandMode(input);
  return {
    default: input.default ?? "ask",
    rules: input.rules ?? [],
    disabledTools: input.disabledTools ?? [],
  };
}

/** Compile a rule glob to an anchored RegExp. `*` → `.*`, `?` → `.`, everything else literal. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

function ruleMatches(rule: PermissionRule, tool: string, target: string): boolean {
  if (!globToRegExp(rule.tool).test(tool)) return false;
  if (rule.pattern !== undefined && !globToRegExp(rule.pattern).test(target)) return false;
  return true;
}

/**
 * Resolve a tool call to an action: the last matching rule's, or the policy default.
 * `disabledTools` short-circuits to `"deny"`.
 */
export function evaluatePolicy(
  policy: NormalizedPermissionPolicy,
  tool: string,
  target: string,
): { action: PermissionAction; rule?: PermissionRule } {
  if (policy.disabledTools.includes(tool)) return { action: "deny" };
  let match: PermissionRule | undefined;
  for (const rule of policy.rules) {
    if (ruleMatches(rule, tool, target)) match = rule;
  }
  return match ? { action: match.action, rule: match } : { action: policy.default };
}

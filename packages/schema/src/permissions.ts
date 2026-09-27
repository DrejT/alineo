/**
 * Permission-policy shapes.
 *
 * Types only — `normalizePermissions()`, `evaluatePolicy()` and the safe-command lists stay
 * in `@alineo-labs/agent`, because they are behaviour and this package has none. The split is
 * the rule everywhere here: if it does nothing at runtime, it lives in the schema.
 *
 * `@alineo-labs/agent` re-exports all of these, so existing imports keep working.
 */

export type PermissionMode = "auto" | "ask" | "readonly";

/**
 * What happens when a rule (or the policy default) matches a tool call:
 * - `allow` — run it, no prompt
 * - `ask` — pause, surface a `permission_request`, wait for a human decision
 * - `deny` — refuse, with a reason the model reads and can adjust to
 * - `rate_limit` — allow up to `limit.count` matching calls per `limit.windowMs`, then deny
 * - `classify` — best-effort read-vs-write triage of the call (today: `bash`/`powershell`
 *   only, splitting on `&&`/`||`/`;`/`|`/newline and checking each sub-command against a
 *   built-in safe-reader list). All sub-commands look read-only → `allow`; anything
 *   unrecognised or a redirect/`sudo`/`rm` → falls through to `ask`. For any other tool,
 *   `classify` is treated as `ask`.
 */
export type PermissionAction = "allow" | "ask" | "deny" | "rate_limit" | "classify";

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
   * Tools the agent may never call. The gate strips these from the model's tool list at
   * session start (via Pi's `setActiveTools`) so the model never attempts them, and also
   * keeps an unconditional `deny` as a backstop for any tool registered after startup
   * (SDK / MCP tools).
   */
  disabledTools?: string[];
  /**
   * If set, the ONLY tools the model may see — the gate calls Pi's `setActiveTools` with
   * this list at session start. `"readonly"` mode expands to this (the read-only tools).
   * Distinct from `disabledTools` (a denylist); this is an allowlist for the toolset.
   */
  restrictToTools?: string[];
}

/** The fully-defaulted shape written to `/etc/alineo-pi.json` and read by the gate. */
export interface NormalizedPermissionPolicy {
  default: PermissionAction;
  rules: PermissionRule[];
  disabledTools: string[];
  /** Empty = no restriction. Non-empty = the exact set of tools the model may see. */
  restrictToTools: string[];
}

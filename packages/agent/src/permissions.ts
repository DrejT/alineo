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

/** Read-only built-in tools — auto-allowed (and the entire toolset) under `"readonly"`. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * First tokens that make a shell command a pure reader — used by the `"classify"` action
 * and by the `bash` rule `"readonly"` installs. Deliberately conservative: an unrecognised
 * command falls through to `ask`, never to `allow`.
 */
export const SAFE_BASH_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "zgrep",
  "find",
  "pwd",
  "whoami",
  "id",
  "env",
  "printenv",
  "echo",
  "printf",
  "which",
  "type",
  "file",
  "stat",
  "wc",
  "date",
  "uname",
  "hostname",
  "df",
  "du",
  "tree",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "true",
  "false",
  "cmp",
  "diff",
  "column",
  "nl",
  "less",
  "more",
  "tac",
  "hexdump",
  "xxd",
  "od",
  "strings",
  "sha1sum",
  "sha256sum",
  "md5sum",
  "cksum",
] as const;

/** `git <sub>` combinations that only read. */
export const SAFE_GIT_SUBCOMMANDS = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "describe",
  "blame",
  "tag",
  "config",
  "ls-files",
  "ls-tree",
  "shortlog",
  "reflog",
  "cat-file",
  "for-each-ref",
  "whatchanged",
  "rev-list",
  "name-rev",
  "symbolic-ref",
  "count-objects",
] as const;

function expandMode(mode: PermissionMode): NormalizedPermissionPolicy | undefined {
  switch (mode) {
    case "auto":
      return undefined; // no gate loaded at all
    case "ask":
      return { default: "ask", rules: [], disabledTools: [], restrictToTools: [] };
    case "readonly":
      return {
        default: "ask",
        rules: [
          ...READ_ONLY_TOOLS.map((tool) => ({ tool, action: "allow" as const })),
          // If a caller widens restrictToTools to re-admit bash, still triage each call
          // rather than gating every one.
          { tool: "bash", action: "classify" as const },
        ],
        disabledTools: [],
        restrictToTools: [...READ_ONLY_TOOLS],
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
    restrictToTools: input.restrictToTools ?? [],
  };
}

const WRAPPER_COMMANDS = new Set(["env", "command", "nice", "stdbuf", "time"]);

/**
 * True if `seg` contains a file output redirection (`> file`, `>> file`). A `>` immediately
 * followed by `&` (`2>&1`, `>&2`), preceded by a digit (`2>`, stderr), or preceded by `&`
 * is a file-descriptor op, not a file write. Linear scan — no regex (ReDoS-safe).
 */
function hasOutputRedirect(seg: string): boolean {
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] !== ">") continue;
    const next = seg[i + 1];
    const prev = seg[i - 1];
    if (next === "&" || prev === "&" || (prev >= "0" && prev <= "9")) continue;
    return true;
  }
  return false;
}

/**
 * Best-effort read-vs-write triage of a shell command. `true` = every sub-command is a
 * recognised pure reader with no output redirection; `false` = something needs a human.
 * Mirrored verbatim in `adapters/pi-permission-gate.js`.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const segments = command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    if (hasOutputRedirect(seg)) return false;
    // Strip leading `VAR=val` assignments and benign wrappers.
    let tokens = seg.split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
    }
    while (tokens.length > 1 && WRAPPER_COMMANDS.has(tokens[0])) tokens = tokens.slice(1);
    if (tokens[0] === "timeout" && tokens.length > 2) tokens = tokens.slice(2);
    const first = tokens[0] ?? "";
    const slash = first.lastIndexOf("/");
    const cmd = slash === -1 ? first : first.slice(slash + 1);
    if (!cmd) return false;
    if ((SAFE_BASH_COMMANDS as readonly string[]).includes(cmd)) return true;
    if (cmd === "git" && (SAFE_GIT_SUBCOMMANDS as readonly string[]).includes(tokens[1] ?? "")) {
      return true;
    }
    return false;
  });
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
 * `disabledTools` short-circuits to `"deny"`. `"classify"` is resolved here to `"allow"`
 * or `"ask"` (bash reader-triage; any other tool → `"ask"`).
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
  const action = match ? match.action : policy.default;
  if (action === "classify") {
    const resolved = tool === "bash" && isReadOnlyBashCommand(target) ? "allow" : "ask";
    return { action: resolved, rule: match };
  }
  return match ? { action: match.action, rule: match } : { action: policy.default };
}

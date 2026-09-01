/**
 * alineo permission gate — a Pi extension loaded via `-e /alineo-permission-gate.js` when
 * `AgentSpec.permissions` is set to anything other than "auto".
 *
 * It reads the normalized policy from /etc/alineo-pi.json (written by
 * `packages/agent/src/adapters/pi.ts`'s `configure()`), and:
 *   - on `session_start`, applies `restrictToTools` / `disabledTools` via Pi's
 *     `setActiveTools` so the model never sees a tool it may not use;
 *   - on every `tool_call`, decides allow / deny / rate-limit / classify / ask. An "ask"
 *     call blocks on `ctx.ui.select()` with a marker-prefixed title that `pi-bridge.js`
 *     recognizes, holds open, and forwards to the host as a `permission_request` — resolved
 *     by a matching POST to `/permission-response`.
 *
 * The matcher here mirrors `packages/agent/src/permissions.ts` (kept in sync by hand — a
 * jiti-loaded extension can't import from the published `alineo` package it sits beside;
 * same tradeoff pi-bridge.js already makes). `test/permissions.test.ts` covers the TS copy;
 * `test/pi-permission-gate.test.ts` covers this one.
 */
import { readFileSync } from "node:fs";

const CONFIG_FILE = process.env.ALINEO_PI_CONFIG || "/etc/alineo-pi.json";
/** Title prefix pi-bridge.js keys on to route a select() dialog to the host instead of auto-cancelling. */
const MARKER = "ALINEO_PERM ";

/** Mirror of `permissions.ts` SAFE_BASH_COMMANDS. */
const SAFE_BASH_COMMANDS = new Set([
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
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
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
]);

/** @returns {{default: string, rules: Array, disabledTools: string[], restrictToTools: string[]} | null} */
function loadPolicy() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const p = cfg && cfg.permissions;
    if (!p || typeof p !== "object") return null;
    return {
      default: p.default || "ask",
      rules: Array.isArray(p.rules) ? p.rules : [],
      disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools : [],
      restrictToTools: Array.isArray(p.restrictToTools) ? p.restrictToTools : [],
    };
  } catch {
    return null;
  }
}

const WRAPPER_COMMANDS = new Set(["env", "command", "nice", "stdbuf", "time"]);

// Linear scan for a file output redirection — no regex (ReDoS-safe). A `>` next to `&`
// (`2>&1`, `>&2`), preceded by a digit (`2>`), or preceded by `&` is an fd op, not a write.
function hasOutputRedirect(seg) {
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] !== ">") continue;
    const next = seg[i + 1];
    const prev = seg[i - 1];
    if (next === "&" || prev === "&" || (prev >= "0" && prev <= "9")) continue;
    return true;
  }
  return false;
}

/** Mirror of `permissions.ts` isReadOnlyBashCommand. */
function isReadOnlyBashCommand(command) {
  const segments = String(command)
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    if (hasOutputRedirect(seg)) return false;
    let tokens = seg.split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
    }
    while (tokens.length > 1 && WRAPPER_COMMANDS.has(tokens[0])) tokens = tokens.slice(1);
    if (tokens[0] === "timeout" && tokens.length > 2) tokens = tokens.slice(2);
    const first = tokens[0] || "";
    const slash = first.lastIndexOf("/");
    const cmd = slash === -1 ? first : first.slice(slash + 1);
    if (!cmd) return false;
    if (SAFE_BASH_COMMANDS.has(cmd)) return true;
    if (cmd === "git" && SAFE_GIT_SUBCOMMANDS.has(tokens[1] || "")) return true;
    return false;
  });
}

/** Tool-specific target string, pulled from Pi's typed `event.input`. */
function targetOf(toolName, input) {
  if (!input || typeof input !== "object") return "";
  switch (toolName) {
    case "bash":
    case "powershell":
      return String(input.command ?? "");
    case "read":
    case "write":
    case "edit":
    case "ls":
      return String(input.path ?? "");
    case "grep":
      return String(input.pattern ?? input.query ?? "");
    case "find":
      return String(input.pattern ?? input.name ?? "");
    default:
      try {
        return JSON.stringify(input);
      } catch {
        return "";
      }
  }
}

function globToRegExp(glob) {
  const body = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

function ruleMatches(rule, toolName, target) {
  if (!globToRegExp(rule.tool).test(toolName)) return false;
  if (
    rule.pattern !== undefined &&
    rule.pattern !== null &&
    !globToRegExp(rule.pattern).test(target)
  ) {
    return false;
  }
  return true;
}

function evaluate(policy, toolName, target) {
  if (policy.disabledTools.indexOf(toolName) !== -1) return { action: "deny" };
  let match;
  for (const rule of policy.rules) {
    if (ruleMatches(rule, toolName, target)) match = rule;
  }
  let action = match ? match.action : policy.default;
  if (action === "classify") {
    action = toolName === "bash" && isReadOnlyBashCommand(target) ? "allow" : "ask";
  }
  return { action, rule: match };
}

/** Rolling-window rate limiter, keyed per rule. */
const rateHits = new Map();
function underLimit(rule, key) {
  if (!rule || !rule.limit) return true;
  const now = Date.now();
  const windowStart = now - rule.limit.windowMs;
  const hits = (rateHits.get(key) || []).filter((t) => t >= windowStart);
  if (hits.length >= rule.limit.count) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

/**
 * Apply `restrictToTools` (allowlist) then `disabledTools` (denylist) to the model's
 * visible toolset. Best-effort: `setActiveTools` may not exist on older Pi — the
 * `tool_call` deny backstop still covers `disabledTools` in that case.
 */
function applyToolset(pi, policy) {
  if (typeof pi.setActiveTools !== "function" || typeof pi.getActiveTools !== "function") {
    return;
  }
  let active = pi.getActiveTools();
  if (!Array.isArray(active)) return;
  if (policy.restrictToTools.length > 0) {
    active = active.filter((t) => policy.restrictToTools.indexOf(t) !== -1);
  }
  if (policy.disabledTools.length > 0) {
    active = active.filter((t) => policy.disabledTools.indexOf(t) === -1);
  }
  try {
    pi.setActiveTools(active);
  } catch {}
}

export default function (pi) {
  const policy = loadPolicy();
  if (!policy) return; // shouldn't happen — the extension is only loaded when a policy exists

  if (policy.restrictToTools.length > 0 || policy.disabledTools.length > 0) {
    if (typeof pi.on === "function") {
      pi.on("session_start", () => {
        applyToolset(pi, policy);
      });
    }
    // Also try immediately, in case session_start already fired before this ran.
    applyToolset(pi, policy);
  }

  /** Session-scoped "always allow" memory, keyed tool + target. */
  const alwaysAllow = new Set();

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const target = targetOf(toolName, event.input);
    const key = `${toolName} ${target}`;

    if (alwaysAllow.has(key)) return undefined;

    const { action, rule } = evaluate(policy, toolName, target);

    if (action === "allow") return undefined;
    if (action === "deny") {
      return {
        block: true,
        reason: `The operator's policy denies this tool call: ${toolName} ${target}`.trim(),
      };
    }
    if (action === "rate_limit") {
      return underLimit(rule, key)
        ? undefined
        : {
            block: true,
            reason: `Rate limit reached for ${toolName}. Wait before trying this again, or take a different approach.`,
          };
    }

    // action === "ask"
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "This tool call needs operator approval, but no UI is attached.",
      };
    }

    const title =
      MARKER + JSON.stringify({ tool: toolName, target, title: `Run ${toolName}: ${target}` });
    let raw;
    try {
      raw = await ctx.ui.select(title, ["decide"]);
    } catch {
      raw = undefined;
    }
    if (raw === undefined || raw === null) {
      return { block: true, reason: "Approval request was cancelled or timed out." };
    }

    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      decision = { verdict: "reject" };
    }

    if (decision.verdict === "allow") {
      if (decision.scope === "always") alwaysAllow.add(key);
      return undefined;
    }
    return {
      block: true,
      reason: decision.feedback
        ? `The operator declined this and said: ${decision.feedback}`
        : "The operator declined this tool call.",
    };
  });
}

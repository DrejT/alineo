/**
 * alineo permission gate — a Pi extension loaded via `-e /alineo-permission-gate.js` when
 * `AgentSpec.permissions` is set to anything other than "auto".
 *
 * It reads the normalized policy from /etc/alineo-pi.json (written by
 * `packages/agent/src/adapters/pi.ts`'s `configure()`), and on every `tool_call` decides
 * allow / deny / rate-limit / ask. An "ask" call blocks on `ctx.ui.select()` with a
 * marker-prefixed title that `pi-bridge.js` recognizes, holds open, and forwards to the
 * host as a `permission_request` — resolved by a matching POST to `/permission-response`.
 *
 * The matcher here mirrors `packages/agent/src/permissions.ts` (kept in sync by hand — a
 * jiti-loaded extension can't import from the published `alineo` package it sits beside;
 * same tradeoff pi-bridge.js already makes). `test/permissions.test.ts` covers the TS copy.
 */
import { readFileSync } from "node:fs";

const CONFIG_FILE = "/etc/alineo-pi.json";
/** Title prefix pi-bridge.js keys on to route a select() dialog to the host instead of auto-cancelling. */
const MARKER = "ALINEO_PERM ";

/** @returns {{default: string, rules: Array, disabledTools: string[]} | null} */
function loadPolicy() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const p = cfg && cfg.permissions;
    if (!p || typeof p !== "object") return null;
    return {
      default: p.default || "ask",
      rules: Array.isArray(p.rules) ? p.rules : [],
      disabledTools: Array.isArray(p.disabledTools) ? p.disabledTools : [],
    };
  } catch {
    return null;
  }
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
  return match ? { action: match.action, rule: match } : { action: policy.default };
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

export default function (pi) {
  const policy = loadPolicy();
  if (!policy) return; // shouldn't happen — the extension is only loaded when a policy exists

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

/**
 * Host-side builders for `agent-browser` CLI commands, for a deterministic workflow that drives
 * a browser inside a sandbox with no LLM:
 *
 * ```ts
 * import { browser } from "@alineo-labs/agent-browser";
 *
 * const b = browser();
 * sb.exec(b.open("https://seller.example.com/login"));
 * sb.exec(b.fill("#username", "accounts@brand.example"));
 * sb.exec(b.fill("#password", "PORTAL_PASSWORD")); // placeholder, swapped by the egress proxy
 * sb.exec(b.click("button[type=submit]"));
 * sb.exec(b.waitForUrl("**\/dashboard", { timeoutMs: 30_000 }), {
 *   as: "login", parse: "json", strict: false,
 * });
 * ```
 *
 * Every command passes `--json`, so stdout is agent-browser's `{ success, data, error }`
 * envelope. Pair a command with `exec(cmd, { as, parse: "json", strict: false })` and branch on
 * `browserOk(vars[as])`. Every argument is shell-quoted.
 *
 * Nothing here names a site. Site URLs, selectors and the order of steps belong to the caller.
 */

/** agent-browser's `--json` output envelope. */
export interface BrowserResult<T = unknown> {
  success: boolean;
  data: T | null;
  error: string | null;
}

/** Options applied to every command a `browser()` builder makes. */
export interface BrowserOptions {
  /** agent-browser `--session`: an isolated browser and daemon. Default: agent-browser's own. */
  session?: string;
  /**
   * agent-browser `--state`: load this storage-state file when the browser launches. Has an
   * effect only on the command that launches the browser (normally the first `open`).
   */
  state?: string;
  /** agent-browser `--download-path`: where browser-initiated downloads land. */
  downloadPath?: string;
  /** agent-browser `--user-agent`. Keep it stable across runs that reuse one session. */
  userAgent?: string;
}

/** Timeout for a command that waits, in milliseconds. */
export interface WaitOptions {
  timeoutMs?: number;
}

/** Quote one argument for `/bin/sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A command builder. Each method returns one shell command string for `sb.exec()`.
 *
 * Selectors are anything agent-browser accepts: CSS (`#login`), or a ref from a snapshot (`@e3`).
 */
export function browser(opts: BrowserOptions = {}) {
  const globals = ["--json"];
  if (opts.session !== undefined) globals.push("--session", shellQuote(opts.session));
  if (opts.state !== undefined) globals.push("--state", shellQuote(opts.state));
  if (opts.downloadPath !== undefined)
    globals.push("--download-path", shellQuote(opts.downloadPath));
  if (opts.userAgent !== undefined) globals.push("--user-agent", shellQuote(opts.userAgent));
  const prefix = `agent-browser ${globals.join(" ")}`;

  const cmd = (...parts: string[]): string => `${prefix} ${parts.join(" ")}`;
  const timeout = (w: WaitOptions): string[] =>
    w.timeoutMs === undefined ? [] : ["--timeout", String(Math.round(w.timeoutMs))];

  return {
    /** Navigate. Launches the browser on first use. */
    open: (url: string) => cmd("open", shellQuote(url)),
    /** Click an element. */
    click: (selector: string) => cmd("click", shellQuote(selector)),
    /** Clear a field and type `text`. Text after `--` is literal, even if it looks like a flag. */
    fill: (selector: string, text: string) =>
      cmd("fill", shellQuote(selector), "--", shellQuote(text)),
    /** Choose an option in a `<select>`. */
    select: (selector: string, value: string) =>
      cmd("select", shellQuote(selector), shellQuote(value)),
    /** Press a key, e.g. `Enter`. */
    press: (key: string) => cmd("press", shellQuote(key)),
    /** Wait until the URL matches a glob, e.g. `**\/dashboard`. */
    waitForUrl: (pattern: string, w: WaitOptions = {}) =>
      cmd("wait", "--url", shellQuote(pattern), ...timeout(w)),
    /** Wait until the page contains `text`. */
    waitForText: (text: string, w: WaitOptions = {}) =>
      cmd("wait", "--text", shellQuote(text), ...timeout(w)),
    /** Wait until an element exists. */
    waitForSelector: (selector: string, w: WaitOptions = {}) =>
      cmd("wait", shellQuote(selector), ...timeout(w)),
    /** Click an element that starts a download, and save the file at `path`. */
    download: (selector: string, path: string) =>
      cmd("download", shellQuote(selector), shellQuote(path)),
    /** Wait for a download that another action started, and move it to `path`. */
    waitForDownload: (path: string, w: WaitOptions = {}) =>
      cmd("wait", "--download", shellQuote(path), ...timeout(w)),
    /** Write cookies and storage of the running browser to `path`. The file holds session tokens. */
    stateSave: (path: string) => cmd("state", "save", shellQuote(path)),
    /** Load a storage-state file into the running browser. */
    stateLoad: (path: string) => cmd("state", "load", shellQuote(path)),
    /** Current page URL. */
    getUrl: () => cmd("get", "url"),
    /** Close the browser. */
    close: () => cmd("close"),
  };
}

/** The builder `browser()` returns. */
export type BrowserCommands = ReturnType<typeof browser>;

/**
 * Parse agent-browser `--json` stdout. Returns `null` if it is not a `{ success, ... }` envelope.
 */
export function parseBrowserResult<T = unknown>(stdout: string): BrowserResult<T> | null {
  try {
    return asBrowserResult<T>(JSON.parse(stdout.trim()));
  } catch {
    return null;
  }
}

/**
 * True when `value` (typically `vars[as]` from `exec(cmd, { as, parse: "json" })`) is a
 * successful agent-browser result.
 */
export function browserOk(value: unknown): boolean {
  return asBrowserResult(value)?.success === true;
}

function asBrowserResult<T>(value: unknown): BrowserResult<T> | null {
  if (typeof value !== "object" || value === null || !("success" in value)) return null;
  const v = value as { success: unknown; data?: unknown; error?: unknown };
  if (typeof v.success !== "boolean") return null;
  return {
    success: v.success,
    data: (v.data ?? null) as T | null,
    error: typeof v.error === "string" ? v.error : null,
  };
}

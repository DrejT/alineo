import type { BrowserOptions } from "./commands";

/** A fixed desktop Chrome user agent, matching the Chrome that `AGENT_BROWSER_VERSION` installs. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

/**
 * Analytics and ad hosts `browserEnv()` blocks by default (`network route <p> --abort`; a
 * pattern with `*` is a wildcard match on the full URL). Google's own domains are left out on
 * purpose: blocking `google.com`/`gstatic.com` also blocks reCAPTCHA, which breaks logins.
 */
export const DEFAULT_BLOCK_HOSTS = [
  "*://*.google-analytics.com/*",
  "*://*.googletagmanager.com/*",
  "*://*.doubleclick.net/*",
  "*://*.googlesyndication.com/*",
  "*://*.facebook.net/*",
  "*://*.hotjar.com/*",
  "*://*.clarity.ms/*",
  "*://*.segment.io/*",
  "*://*.sentry.io/*",
];

/**
 * Browser options that keep runs comparable: fixed user agent, viewport, locale, timezone and
 * timeout, `--pin-tab`, instant input, and the analytics/ad hosts blocked. Pass the result to
 * `browser()` and run `b.setup()` once before the first real navigation. Override any field.
 *
 * @example
 * ```ts
 * const b = browser(browserEnv({ timezone: "Asia/Kolkata" }));
 * for (const c of b.setup()) sb.exec(c);
 * sb.exec(b.open("https://app.example.com/login"));
 * ```
 */
export function browserEnv(overrides: BrowserOptions = {}): BrowserOptions {
  return {
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezone: "UTC",
    timeoutMs: 30_000,
    pinTab: true,
    inputMode: "instant",
    blockHosts: DEFAULT_BLOCK_HOSTS,
    ...overrides,
  };
}

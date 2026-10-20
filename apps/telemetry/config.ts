/** Standalone by design -- this app has no dependency on apps/dashboard, apps/sandbox, or any
 * other app in this repo, and vice versa. */
export const PORT = Number(process.env.PORT ?? 3002);

export const DB_PATH = process.env.TELEMETRY_DB_PATH ?? "./data/telemetry.db";

/** Per-`anonymousId` sliding-window cap -- generous headroom above any real single CLI's actual
 * invocation rate, while still bounding abuse of this unauthenticated, public endpoint. */
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** A CliTelemetryEvent is a handful of short strings/booleans -- anything meaningfully larger
 * than this is not a real event. */
export const MAX_BODY_BYTES = 4096;

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** PostHog forward (see posthog.ts). `POSTHOG_KEY` is a write-only project key, not a secret, but
 * leaving it unset is the off switch: tests and local runs forward nothing. */
export const POSTHOG_KEY = process.env.POSTHOG_KEY ?? "";
export const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

/** Event or command names to keep out of PostHog. A trailing `*` matches a prefix. Changing it
 * needs a container restart, not a release -- SQLite still keeps every event. */
export const POSTHOG_DENY = list(process.env.POSTHOG_DENY);

/** `anonymousId` values to tag `internal: true`, so PostHog can filter out the maintainer's own
 * machines. Stays a list until the CLI sends a build type. */
export const INTERNAL_IDS: ReadonlySet<string> = new Set(list(process.env.INTERNAL_IDS));

/** Public source addresses to treat as the maintainer's, on top of any private or loopback one
 * (see `isInternalAddress`). Covers sandbox containers on the VPS, whose `anonymousId` changes
 * every time. The address is compared and dropped, never stored. */
export const INTERNAL_IPS: ReadonlySet<string> = new Set(list(process.env.INTERNAL_IPS));

/** Per command and outcome per UTC day. Bounds a retry loop, not normal use. */
export const POSTHOG_DAILY_CAP = Number(process.env.POSTHOG_DAILY_CAP ?? 500);
export const POSTHOG_BATCH_SIZE = 20;
export const POSTHOG_FLUSH_INTERVAL_MS = 5_000;
export const POSTHOG_TIMEOUT_MS = 3_000;
export const POSTHOG_RETRY_DELAY_MS = 500;

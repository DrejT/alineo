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

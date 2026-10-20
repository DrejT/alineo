/** The process-wide PostHog forwarder, built once from the environment. Tests build their own
 * through `createForwarder` and pass it to `postEvent`. */
import {
  INTERNAL_IDS,
  POSTHOG_BATCH_SIZE,
  POSTHOG_DAILY_CAP,
  POSTHOG_DENY,
  POSTHOG_FLUSH_INTERVAL_MS,
  POSTHOG_HOST,
  POSTHOG_KEY,
  POSTHOG_RETRY_DELAY_MS,
  POSTHOG_TIMEOUT_MS,
} from "./config";
import { createForwarder } from "./posthog";

export const forwarder = createForwarder({
  key: POSTHOG_KEY,
  host: POSTHOG_HOST,
  deny: POSTHOG_DENY,
  internalIds: INTERNAL_IDS,
  dailyCap: POSTHOG_DAILY_CAP,
  batchSize: POSTHOG_BATCH_SIZE,
  flushIntervalMs: POSTHOG_FLUSH_INTERVAL_MS,
  timeoutMs: POSTHOG_TIMEOUT_MS,
  retryDelayMs: POSTHOG_RETRY_DELAY_MS,
});

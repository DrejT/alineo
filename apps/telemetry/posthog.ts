/**
 * Forwards accepted telemetry events to PostHog. SQLite stays the source of truth: this module
 * only ever sees an event after `insertEvent` has stored it, and nothing here can fail an ingest.
 *
 * Zero dependencies on purpose (see `db.ts`): the capture API is one POST, so `fetch` is enough
 * and `posthog-node` would be the first dependency this app ever had.
 *
 * Plan: plans/20-10-2026/posthog-telemetry-forward.md
 */
import type { CliTelemetryEvent } from "./db";

export const RUN_EVENT = "cli_command_run";
export const EXCEPTION_EVENT = "$exception";

/** Bumped when a property is renamed or removed, so a chart can tell the two shapes apart. */
const SCHEMA_VERSION = 1;

const DAY_MS = 86_400_000;

export type TenureBucket = "day_1" | "week_1" | "month_1" | "month_3" | "older";

/** A closed vocabulary, so tenure charts as a plain breakdown and never exposes an install date. */
export function tenureBucket(firstSeenAt: number | null, now: number): TenureBucket {
  if (firstSeenAt === null) return "day_1";
  const days = (now - firstSeenAt) / DAY_MS;
  if (days < 1) return "day_1";
  if (days < 7) return "week_1";
  if (days < 30) return "month_1";
  if (days < 90) return "month_3";
  return "older";
}

export interface PostHogEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface MapContext {
  receivedAt: number;
  firstSeenAt: number | null;
  internalIds: ReadonlySet<string>;
}

/**
 * One run event per accepted event, plus an `$exception` for an error outcome so PostHog Error
 * Tracking groups failures into issues. The CLI sends a class name and nothing else (no message,
 * no stack), so the default grouping would collapse; the fingerprint is therefore set here, one
 * issue per command and error class.
 *
 * Every property comes from `CliTelemetryEvent`, which `validateEvent` already restricts to the
 * fields the telemetry docs list. Nothing is added from the request itself: no IP, no headers.
 */
export function toPostHogEvents(event: CliTelemetryEvent, ctx: MapContext): PostHogEvent[] {
  const shared: Record<string, unknown> = {
    command: event.command,
    outcome: event.outcome,
    cli_version: event.cliVersion,
    os_platform: event.osPlatform,
    os_arch: event.osArch,
    bun_version: event.bunVersion,
    is_ci: event.isCI,
    internal: ctx.internalIds.has(event.anonymousId),
    tenure_bucket: tenureBucket(ctx.firstSeenAt, ctx.receivedAt),
    schema_version: SCHEMA_VERSION,
    // This runs on the VPS, so geoip would place every user at the VPS location.
    $geoip_disable: true,
    $lib: "alineo-telemetry",
  };
  const base = {
    distinct_id: event.anonymousId,
    timestamp: new Date(ctx.receivedAt).toISOString(),
  };

  const run: PostHogEvent = {
    event: RUN_EVENT,
    ...base,
    properties: {
      ...shared,
      duration_ms: event.durationMs,
      flags: event.flags,
      ...(event.specProvider !== undefined && { spec_provider: event.specProvider }),
      ...(event.errorClass !== undefined && { error_class: event.errorClass }),
    },
  };
  if (event.outcome !== "error") return [run];

  const errorClass = event.errorClass ?? "UnknownError";
  const exception: PostHogEvent = {
    event: EXCEPTION_EVENT,
    ...base,
    properties: {
      ...shared,
      $exception_list: [
        {
          type: errorClass,
          value: `${event.command} failed`,
          mechanism: { handled: true, synthetic: true },
        },
      ],
      $exception_fingerprint: `${event.command}:${errorClass}`,
      $issue_name: `${event.command}: ${errorClass}`,
    },
  };
  return [run, exception];
}

/** Entries are case-insensitive. A trailing `*` matches a prefix. */
export function compileDenyList(entries: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (prefix) prefixes.push(prefix);
    } else {
      exact.add(entry);
    }
  }
  return (name) => {
    const n = name.toLowerCase();
    return exact.has(n) || prefixes.some((p) => n.startsWith(p));
  };
}

export interface ForwarderOptions {
  /** Empty or undefined disables the forward entirely. */
  key?: string;
  host: string;
  deny: readonly string[];
  internalIds: ReadonlySet<string>;
  /** Per `command` and `outcome` per UTC day. A run event and its `$exception` count as one. */
  dailyCap: number;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  retryDelayMs: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ForwardInput {
  event: CliTelemetryEvent;
  receivedAt: number;
  firstSeenAt: number | null;
}

export interface PostHogForwarder {
  /** Never throws and never blocks the caller. */
  forward(input: ForwardInput): void;
  /** Sends whatever is queued. Resolves when done, and also when sending failed. */
  flush(): Promise<void>;
}

export function createForwarder(options: ForwarderOptions): PostHogForwarder {
  const { key, host, internalIds, dailyCap, batchSize, flushIntervalMs, timeoutMs, retryDelayMs } =
    options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.warn(`[telemetry] ${m}`));

  if (!key) return { forward: () => {}, flush: async () => {} };

  const isDenied = compileDenyList(options.deny);
  const url = `${host.replace(/\/+$/, "")}/batch/`;

  let queue: PostHogEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  let capDay = "";
  const counts = new Map<string, number>();
  const warned = new Set<string>();

  function underCap(command: string, outcome: string, at: number): boolean {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day !== capDay) {
      capDay = day;
      counts.clear();
      warned.clear();
    }
    const bucket = `${command}:${outcome}`;
    const used = counts.get(bucket) ?? 0;
    if (used >= dailyCap) {
      if (!warned.has(bucket)) {
        warned.add(bucket);
        log(`posthog daily cap of ${dailyCap} reached for ${bucket}, dropping the rest of the day`);
      }
      return false;
    }
    counts.set(bucket, used + 1);
    return true;
  }

  async function send(batch: PostHogEvent[]): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, batch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return;
        // A 4xx will not improve on a retry.
        if (res.status < 500) {
          log(`posthog rejected a batch of ${batch.length} with status ${res.status}`);
          return;
        }
      } catch {
        // Network error or timeout: fall through to the retry.
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    log(`posthog unreachable, dropped a batch of ${batch.length} (the rows are in SQLite)`);
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    await send(batch);
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    // A pending flush must not keep the process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    forward({ event, receivedAt, firstSeenAt }) {
      try {
        if (isDenied(event.command)) return;
        if (!underCap(event.command, event.outcome, now())) return;
        const events = toPostHogEvents(event, { receivedAt, firstSeenAt, internalIds });
        queue.push(...events.filter((e) => !isDenied(e.event)));
        if (queue.length >= batchSize) void flush();
        else schedule();
      } catch (err) {
        log(`posthog forward failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    flush,
  };
}

/**
 * `POST /v1/events` -- the only route this app has. Re-validates the event against the exact
 * same allowlisted shape `alineo` claims to send (defense in depth -- never trust that a client
 * only ever sends what its own code says it will): any unexpected top-level field, or a known
 * field of the wrong type, is rejected outright rather than silently dropped.
 */
import { insertEvent, type CliTelemetryEvent } from "../db";
import { MAX_BODY_BYTES, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "../config";

const KNOWN_FIELDS = new Set([
  "command",
  "flags",
  "specProvider",
  "outcome",
  "errorClass",
  "durationMs",
  "cliVersion",
  "osPlatform",
  "osArch",
  "bunVersion",
  "isCI",
  "anonymousId",
]);

/** Bounded flags object -- a real command's own allowlist (owned by `packages/cli`, not
 * duplicated here) never has more than a handful of entries; this is a structural cap, not
 * per-command knowledge, so this app doesn't need to know every command's own flag schema to
 * stay decoupled from `packages/cli`. */
const MAX_FLAGS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEvent(value: unknown): CliTelemetryEvent {
  if (!isPlainObject(value)) throw new Error("body must be a JSON object");

  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) throw new Error(`unexpected field: "${key}"`);
  }

  const {
    command,
    flags,
    specProvider,
    outcome,
    errorClass,
    durationMs,
    cliVersion,
    osPlatform,
    osArch,
    bunVersion,
    isCI,
    anonymousId,
  } = value;

  if (typeof command !== "string" || !command.trim())
    throw new Error(`"command" must be a non-empty string`);
  if (!isPlainObject(flags)) throw new Error(`"flags" must be an object`);
  const flagEntries = Object.entries(flags);
  if (flagEntries.length > MAX_FLAGS) throw new Error(`"flags" has too many entries`);
  for (const [k, v] of flagEntries) {
    if (typeof v !== "boolean") throw new Error(`"flags.${k}" must be a boolean`);
  }
  if (specProvider !== undefined && typeof specProvider !== "string") {
    throw new Error(`"specProvider" must be a string if present`);
  }
  if (outcome !== "success" && outcome !== "error") {
    throw new Error(`"outcome" must be "success" or "error"`);
  }
  if (errorClass !== undefined && typeof errorClass !== "string") {
    throw new Error(`"errorClass" must be a string if present`);
  }
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`"durationMs" must be a non-negative number`);
  }
  for (const [name, v] of [
    ["cliVersion", cliVersion],
    ["osPlatform", osPlatform],
    ["osArch", osArch],
    ["bunVersion", bunVersion],
    ["anonymousId", anonymousId],
  ] as const) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`"${name}" must be a non-empty string`);
  }
  if (typeof isCI !== "boolean") throw new Error(`"isCI" must be a boolean`);

  return {
    command,
    flags: flags as Record<string, boolean>,
    specProvider: specProvider as string | undefined,
    outcome,
    errorClass: errorClass as string | undefined,
    durationMs,
    cliVersion: cliVersion as string,
    osPlatform: osPlatform as string,
    osArch: osArch as string,
    bunVersion: bunVersion as string,
    isCI,
    anonymousId: anonymousId as string,
  };
}

/** In-memory sliding window, per `anonymousId` -- this endpoint has no auth (there's no user
 * identity to authenticate, the data is anonymous by design), so this is the only abuse guard
 * for a single reporter sending too often. Module-level, reset on process restart -- acceptable
 * for a crude rate limit whose only job is bounding a runaway/misbehaving client, not billing. */
const requestTimestamps = new Map<string, number[]>();

function isRateLimited(anonymousId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = (requestTimestamps.get(anonymousId) ?? []).filter((t) => t > cutoff);
  if (existing.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestTimestamps.set(anonymousId, existing);
    return true;
  }
  existing.push(now);
  requestTimestamps.set(anonymousId, existing);
  return false;
}

export async function postEvent(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  let event: CliTelemetryEvent;
  try {
    event = validateEvent(parsed);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  if (isRateLimited(event.anonymousId)) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  insertEvent(event);
  return new Response(null, { status: 204 });
}

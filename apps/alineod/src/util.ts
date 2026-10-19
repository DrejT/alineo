/** Small helpers shared by the engine and the route modules. */
import { errorCodeFromText, errorCodeOf } from "@alineo-labs/errors";
import type { ErrorCode } from "@alineo-labs/errors";

/**
 * Race a promise against a timeout, returning `undefined` instead of hanging or throwing.
 * For best-effort live-agent calls (`getState()`, `getSessionStats()`, …) where a paused or
 * unresponsive bridge would otherwise leave the caller waiting forever.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * An error as one line of text. OpenSandbox's client puts the raw response body in `message`
 * (`{"code":"DOCKER::SANDBOX_NOT_FOUND","message":"Sandbox … not found."}`), which reads badly in
 * a log line or a ledger `error` field — unwrap it to `Sandbox … not found. (DOCKER::SANDBOX_NOT_FOUND)`.
 * Anything that isn't that shape is returned unchanged.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.startsWith("{")) return raw;
  try {
    const body = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof body.message !== "string" || body.message === "") return raw;
    return typeof body.code === "string" ? `${body.message} (${body.code})` : body.message;
  } catch {
    return raw;
  }
}

/**
 * What a failure records on the ledger: the message, plus a stable `errorCode` when one is known.
 *
 * The code comes from the error itself (an `AlineoError`, or a code down its `cause` chain). When
 * the failure arrives only as text, which is how a model provider's 429 reaches us from the Pi
 * bridge, it is classified from the text. `errorCode` is left out, not set to a placeholder, when
 * nothing matches.
 */
export function errorFields(err: unknown): { error: string; errorCode?: ErrorCode } {
  const error = errorMessage(err);
  const errorCode = errorCodeOf(err) ?? errorCodeFromText(error);
  return errorCode ? { error, errorCode } : { error };
}

/**
 * The sandbox provider that owns an agent's sandbox, for the `agent.provisioned` event.
 *
 * Read off the handle, which the client that created it stamped. Optional chaining because a
 * test double or an older `alineo` build may not carry it, and an absent value means OpenSandbox.
 */
export function providerOf(agent: { sandbox?: { provider?: string } }): string | undefined {
  return agent.sandbox?.provider;
}

/**
 * A concurrency cap: `limit(fn)` runs `fn` once fewer than `max` earlier calls are still running,
 * and resolves or rejects with whatever `fn` does. A rejection frees its slot like a success.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running < max) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over by release()
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Run `fn` over `items`, at most `max` at a time. Resolves when all have finished. */
export async function mapLimit<T>(
  items: readonly T[],
  max: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const limit = createLimiter(max);
  await Promise.all(items.map((item) => limit(() => fn(item))));
}

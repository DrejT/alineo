import { ERROR_CODES, isErrorCode } from "./codes";
import type { ErrorCategory, ErrorCode } from "./codes";

/**
 * Marks an error as an AlineoError without relying on `instanceof`. Two copies of this package
 * (a bundled consumer next to a published one) produce two distinct classes, and `instanceof`
 * across them is false. A shared symbol survives that.
 */
const BRAND = Symbol.for("alineo.error");

/** Structured context on an error. Scalars only, so it survives JSON and never holds a secret. */
export type ErrorDetails = Record<string, string | number | boolean | undefined>;

export interface AlineoErrorOptions {
  /** The underlying failure. Preserved on `Error.cause`. */
  cause?: unknown;
  /** Overrides the default hint for this code. */
  hint?: string;
  /** Structured context: ids, counts, durations. Never secrets. */
  details?: ErrorDetails;
}

/**
 * Base class for every error alineo raises on purpose.
 *
 * Carries a stable {@link ErrorCode}. Branch on `code` (or {@link errorCodeOf}), not on the
 * class name or the message.
 */
export class AlineoError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  /** True when the same call, unchanged, may succeed on a later attempt. */
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: ErrorDetails;
  readonly [BRAND] = true;

  constructor(code: ErrorCode, message: string, options: AlineoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AlineoError";
    const spec = ERROR_CODES[code];
    this.code = code;
    this.category = spec.category;
    this.retryable = spec.retryable;
    const hint = options.hint ?? ("hint" in spec ? spec.hint : undefined);
    if (hint !== undefined) this.hint = hint;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** True for an AlineoError, including one made by another copy of this package. */
export function isAlineoError(value: unknown): value is AlineoError {
  if (value instanceof AlineoError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true &&
    isErrorCode((value as { code?: unknown }).code)
  );
}

/** How far down an `Error.cause` chain {@link errorCodeOf} looks. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The alineo code behind a thrown value, or `undefined` when it has none.
 *
 * Looks at the error itself, then down its `cause` chain, so a wrapper that kept the original
 * as `cause` does not hide the code. Accepts a bare `code` string that matches a known code,
 * which is how a code that crossed a JSON boundary (an HTTP body) is read back.
 */
export function errorCodeOf(value: unknown): ErrorCode | undefined {
  let current: unknown = value;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (isErrorCode(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether retrying the same call may help. `undefined` when the value carries no known code,
 * so a caller can fall back to its own default instead of treating "unknown" as "no".
 */
export function isRetryable(value: unknown): boolean | undefined {
  const code = errorCodeOf(value);
  return code === undefined ? undefined : ERROR_CODES[code].retryable;
}

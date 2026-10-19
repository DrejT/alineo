import type { ErrorCode } from "@alineo-labs/errors";

/**
 * A thrown error carrying an HTTP status — routes map it straight to a response.
 *
 * `code` is an optional stable error code (see `@alineo-labs/errors`) sent beside the message, so
 * a client can branch on it instead of on text.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ErrorCode,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

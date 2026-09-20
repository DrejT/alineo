/**
 * Small helpers shared by the route modules. Bodies are validated with the Zod schemas from
 * schema.ts directly (predictable at runtime); the OpenAPI document is emitted separately
 * from the same schemas by scripts/emit-spec.ts. See the README for why it's split.
 */
import type { ZodType } from "zod";
import { getLogger } from "@alineo-labs/logger";
import { HttpError } from "../engine/errors";

const log = getLogger("alineod");

/** Elysia error codes that mean "the client sent something wrong", not "alineod broke". */
const CLIENT_ERROR_CODES = new Set([
  "NOT_FOUND",
  "VALIDATION",
  "PARSE",
  "INVALID_COOKIE_SIGNATURE",
]);

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(
      400,
      `invalid request body: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

export { withTimeout } from "../util";

/**
 * Map a thrown error to an Elysia response. Wired as `.onError` in app.ts. Expected rejections
 * (`HttpError`, client mistakes) log at debug; anything else is a bug in alineod and logs at
 * error with the request that triggered it — before this, a 500 reached the client and left no
 * trace on the server.
 */
export function toErrorResponse(
  err: unknown,
  context: { request?: Request; code?: string | number } = {},
): Response {
  const where = context.request
    ? { method: context.request.method, path: new URL(context.request.url).pathname }
    : {};
  if (err instanceof HttpError) {
    log.debug("request rejected", { ...where, status: err.status, error: err.message });
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (CLIENT_ERROR_CODES.has(String(context.code))) {
    log.debug("request failed", { ...where, code: context.code, error: message });
  } else {
    log.error("unhandled error", { ...where, err });
  }
  return Response.json({ error: message }, { status: 500 });
}

/**
 * Small helpers shared by the route modules. Bodies are validated with the Zod schemas from
 * schema.ts directly (predictable at runtime); the OpenAPI document is emitted separately
 * from the same schemas by scripts/emit-spec.ts. See the README for why it's split.
 */
import type { ZodType } from "zod";
import { getLogger } from "@alineo-labs/logger";
import { HttpError } from "../engine/errors";

const log = getLogger("alineod");

/**
 * Errors Elysia raises before or around a handler, and the status each deserves. All of them are
 * the client's doing — no such route, an unparseable body — so none may fall through to the 500
 * that means "alineod broke". (`undefined` = not one of these.)
 */
function elysiaClientStatus(code: string | number | undefined): 404 | 400 | undefined {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "PARSE":
    case "VALIDATION":
    case "INVALID_COOKIE_SIGNATURE":
      return 400;
    default:
      return undefined;
  }
}

/**
 * What the client is told. Stable text, not Elysia's own: its unknown-route message is the bare
 * code `NOT_FOUND`, and a JSON parse error echoes fragments of the request body. (The raw message
 * still goes to the debug log.)
 */
function clientMessage(code: string | number | undefined, raw: string): string {
  if (code === "NOT_FOUND") return "not found";
  if (code === "PARSE") return "invalid request body: could not be parsed";
  return raw;
}

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
 * Map a thrown error to an Elysia response. Wired as `.onError` in app.ts.
 *
 * - `HttpError` → its own status.
 * - Elysia's client errors (unknown route → 404, unparseable body → 400) → that status. They used
 *   to fall through to the 500 below, contradicting http-api.mdx ("an invalid body is 400").
 * - Anything else is a bug in alineod: 500, logged at error with the request that triggered it.
 *
 * Expected rejections and client mistakes log at debug only.
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
  const clientStatus = elysiaClientStatus(context.code);
  if (clientStatus !== undefined) {
    log.debug("request failed", {
      ...where,
      code: context.code,
      status: clientStatus,
      error: message,
    });
    return Response.json({ error: clientMessage(context.code, message) }, { status: clientStatus });
  }
  log.error("unhandled error", { ...where, err });
  return Response.json({ error: message }, { status: 500 });
}

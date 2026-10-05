/** Small helpers shared by the route modules: errors, body parsing, error-to-response mapping. */
import type { ZodType } from "zod";
import { getLogger } from "@alineo-labs/logger";

const log = getLogger("dashboard");

/** A thrown error carrying an HTTP status — routes map it straight to a response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    throw new HttpError(400, `invalid request body: ${issues.join("; ")}`);
  }
  return r.data;
}

/** Wired as `.onError` in app.ts. `HttpError` keeps its status, Elysia's own client errors map
 *  to 404/400, and anything else is a bug here: 500, logged with the request that caused it. */
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
  if (context.code === "NOT_FOUND") return Response.json({ error: "not found" }, { status: 404 });
  if (context.code === "PARSE" || context.code === "VALIDATION") {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  log.error("unhandled error", { ...where, err });
  return Response.json({ error: errorMessage(err) }, { status: 500 });
}

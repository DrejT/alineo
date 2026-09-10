/**
 * Small helpers shared by the route modules. Bodies are validated with the Zod schemas from
 * schema.ts directly (predictable at runtime); the OpenAPI document is emitted separately
 * from the same schemas by scripts/emit-spec.ts. See the README for why it's split.
 */
import type { ZodType } from "zod";
import { HttpError } from "../engine/errors";

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, `invalid request body: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

/** Map a thrown error to an Elysia response. Wired as `.onError` in server.ts. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 500 });
}

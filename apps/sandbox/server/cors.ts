import * as config from "./config";

/**
 * CORS headers for a given request. The API is called from more than one browser
 * origin (the dashboard frontend and the docs playground, on separate deploys),
 * so a single fixed `Access-Control-Allow-Origin` won't do — reflect the caller's
 * `Origin` when it's on the allowlist, and fall back to the canonical dashboard
 * origin otherwise (keeps non-browser callers and unknown origins predictable).
 */
function headers(req?: Request): Headers {
  const origin = req?.headers.get("origin") ?? "";
  const allowed = config.ALLOWED_ORIGINS.includes(origin)
    ? origin
    : config.ALLOWED_ORIGINS[0];
  return new Headers({
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  });
}

function withCors(res: Response, req?: Request): Response {
  const merged = new Headers(res.headers);
  for (const [key, value] of headers(req)) merged.set(key, value);
  return new Response(res.body, { status: res.status, headers: merged });
}

type RouteHandler = (...args: never[]) => Response | Promise<Response>;

/**
 * Wraps a Bun route method-map so every response carries CORS headers and
 * `OPTIONS` preflight requests are answered automatically. Bun invokes every
 * route handler with `(req, server)`, so `args[0]` is the `Request` even for
 * handlers that ignore it — that's what lets us reflect the caller's `Origin`.
 */
export function cors<T extends Record<string, RouteHandler>>(
  handlers: T,
): T & { OPTIONS: (req: Request) => Response } {
  const wrapped = {
    OPTIONS: (req: Request) => new Response(null, { status: 204, headers: headers(req) }),
  } as T & {
    OPTIONS: (req: Request) => Response;
  };
  for (const [method, handler] of Object.entries(handlers)) {
    (wrapped as Record<string, RouteHandler>)[method] = async (...args: never[]) => {
      const req = args[0] as Request | undefined;
      return withCors(await handler(...args), req);
    };
  }
  return wrapped;
}

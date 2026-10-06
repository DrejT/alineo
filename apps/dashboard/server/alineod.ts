/**
 * The dashboard server's only link to alineod: plain HTTP to its public API. Nothing here opens
 * alineod's database or imports its engine, so alineod keeps its single-writer design.
 */
import { config } from "./config";
import { HttpError, errorMessage } from "./http";

/** JSON call to alineod. A non-2xx answer becomes an `HttpError` with alineod's own status. */
export async function alineodJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.alineodUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new HttpError(502, `alineod unreachable at ${config.alineodUrl}: ${errorMessage(err)}`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok)
    throw new HttpError(res.status, data?.error ?? `alineod ${method} ${path} → ${res.status}`);
  return data as T;
}

export async function alineodReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.alineodUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

/**
 * Forwards a browser request to alineod unchanged and streams the answer back. The body is not
 * parsed and the response is not buffered, so SSE (`/runs/:id/events`) and its `Last-Event-ID`
 * replay work as if the browser spoke to alineod directly. The browser's `Authorization` header
 * is never forwarded.
 */
export async function forward(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${config.alineodUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      signal: request.signal, // a closed browser tab closes the upstream stream too
      // @ts-expect-error bun's fetch accepts `duplex` for streamed request bodies
      duplex: "half",
    });
  } catch (err) {
    return Response.json(
      { error: `alineod unreachable at ${config.alineodUrl}: ${errorMessage(err)}` },
      { status: 502 },
    );
  }
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key)) out.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

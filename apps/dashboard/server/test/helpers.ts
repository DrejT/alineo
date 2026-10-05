/** Shared test helpers: drive routes in-process and poll for async state. */
import { createApp } from "../app";

export const app = createApp();

export const TOKEN = "test-token";

export interface CallResult<T> {
  status: number;
  body: T;
}

// oxlint-disable-next-line typescript/no-explicit-any -- route bodies are asserted field by field
export async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<CallResult<T>> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.handle(new Request(`http://dashboard.test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Poll until `fn` returns a truthy value, or fail after `timeoutMs`. */
export async function until<T>(
  fn: () => T | Promise<T>,
  what = "condition",
  timeoutMs = 5_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

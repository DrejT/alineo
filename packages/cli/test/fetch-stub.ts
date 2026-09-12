import { mock } from "bun:test";

/** A `mock()` that is also assignable to `typeof fetch`, which requires Bun's `preconnect` static. */
export function stubFetch(
  impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return Object.assign(mock(impl), { preconnect: () => {} });
}

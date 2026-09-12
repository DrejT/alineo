import { mock } from "bun:test";

/** A bun:test mock, structurally widened to satisfy `typeof fetch` (which requires Bun's
 * `preconnect` static, absent from `mock()`'s own return type regardless of `impl`'s signature)
 * -- shared by every provider test file instead of a cast at each call site. Still a real
 * `Mock` (assertable via `expect(stubFetch(...)).not.toHaveBeenCalled()` etc.), just also
 * assignable directly to `globalThis.fetch` with no cast needed at the assignment site. */
export function stubFetch(
  impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return Object.assign(mock(impl), { preconnect: () => {} });
}

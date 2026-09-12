import { vi } from "vitest";
import type { SandboxControlDeps } from "../src/sandbox/index.ts";

/** Full stub for `SandboxControlDeps` -- every method defaults to an untyped `vi.fn()` no-op
 * (contextually typed to match, never actually invoked unless a test configures it), so a test
 * only needs to override the handful of methods it actually exercises instead of satisfying the
 * whole shape by hand (or reaching for a cast). */
export function makeControlStub(overrides: Partial<SandboxControlDeps> = {}): SandboxControlDeps {
  return {
    createSnapshot: vi.fn(),
    deleteSandbox: vi.fn(),
    getDiagnosticEvents: vi.fn(),
    getDiagnosticLogs: vi.fn(),
    getEndpoint: vi.fn(),
    getSandbox: vi.fn(),
    getSnapshot: vi.fn(),
    pauseSandbox: vi.fn(),
    resumeSandbox: vi.fn(),
    ...overrides,
  };
}

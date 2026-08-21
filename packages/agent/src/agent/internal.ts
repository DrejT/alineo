import type { SandboxHandle } from "@alineo-labs/core";
import type { PiAdapter } from "../adapters/pi";

/**
 * Narrow surface that `session-control.ts`/`model.ts`/`introspection.ts`/
 * `lifecycle.ts` need from `Alineo` — deliberately not exported from the
 * package barrel, so it never becomes public API even though it's a real
 * exported interface within the package.
 */
export interface AgentInternal {
  readonly adapter: PiAdapter;
  readonly sandbox: SandboxHandle;
  env: Record<string, string>;
}

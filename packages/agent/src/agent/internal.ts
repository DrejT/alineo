import type { SandboxHandle } from "@alineo-labs/core";
import type { HarnessAdapter } from "../harness";
import type { EgressApprovalGate } from "./egress-approval";

/**
 * Narrow surface that `session-control.ts`/`model.ts`/`introspection.ts`/
 * `lifecycle.ts` need from `Alineo` — deliberately not exported from the
 * package barrel, so it never becomes public API even though it's a real
 * exported interface within the package.
 */
export interface AgentInternal {
  readonly adapter: HarnessAdapter;
  readonly sandbox: SandboxHandle;
  env: Record<string, string>;
  /** Present when the spec has `approval: "hold"` credential bindings. */
  readonly egressGate?: EgressApprovalGate;
}

import { WorkflowError } from "@alineo-labs/core";
import { PiAdapter } from "../adapters/pi";
import type { AgentInternal } from "./internal";

/**
 * The agent's adapter as a `PiAdapter`, for an operation only Pi has (`exportHtml`,
 * `cycleModel`, and so on). Throws `CAPABILITY_UNSUPPORTED` naming the operation and the
 * harness when the agent runs a different one. It is the single place `Alineo` narrows from
 * `HarnessAdapter` to a concrete class.
 */
export function pi(a: Pick<AgentInternal, "adapter">, operation: string): PiAdapter {
  if (a.adapter instanceof PiAdapter) return a.adapter;
  throw new WorkflowError(
    `The ${a.adapter.id} harness does not support ${operation}`,
    "CAPABILITY_UNSUPPORTED",
    { details: { operation, harness: a.adapter.id } },
  );
}

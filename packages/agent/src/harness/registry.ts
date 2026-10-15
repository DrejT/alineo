import { WorkflowError } from "@alineo-labs/core";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { PiAdapter } from "../adapters/pi";
import type { HarnessAdapter } from "./adapter";
import type { HarnessCapability } from "./capabilities";

/**
 * Every harness the SDK can drive, by id, and the concrete adapter class for each.
 *
 * The concrete type is here, not just `HarnessAdapter`, because `Alineo` still calls Pi-only
 * methods. When those move behind `agent.harness<"pi">()`, this map is what types that call.
 */
export interface HarnessRegistry {
  pi: PiAdapter;
  "claude-code": ClaudeCodeAdapter;
}

const constructors: { [K in keyof HarnessRegistry]: () => HarnessRegistry[K] } = {
  pi: () => new PiAdapter(),
  "claude-code": () => new ClaudeCodeAdapter(),
};

/** The ids `createHarness()` accepts. */
export function registeredHarnesses(): string[] {
  return Object.keys(constructors);
}

/**
 * Create the adapter for a harness id. The only place an adapter class is constructed.
 * Throws `SPEC_INVALID` for an id nothing registered.
 */
export function createHarness<K extends keyof HarnessRegistry>(id: K): HarnessRegistry[K] {
  const make = constructors[id] as (() => HarnessRegistry[K]) | undefined;
  if (!make) {
    throw new WorkflowError(`Unknown harness "${String(id)}"`, "SPEC_INVALID", {
      details: { harness: String(id), registered: registeredHarnesses().join(",") },
      hint: `Set "harness" to one of: ${registeredHarnesses().join(", ")}.`,
    });
  }
  return make();
}

/**
 * Refuse a call the harness declared it cannot do, before anything is sent. Same idea as
 * `requireCapability` for sandbox providers.
 */
export function requireHarnessCapability(
  adapter: Pick<HarnessAdapter, "id" | "capabilities">,
  capability: HarnessCapability,
): void {
  if (adapter.capabilities[capability]) return;
  throw new WorkflowError(
    `The ${adapter.id} harness does not support ${capability}`,
    "CAPABILITY_UNSUPPORTED",
    { details: { capability, harness: adapter.id } },
  );
}

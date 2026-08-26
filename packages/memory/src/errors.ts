import { WorkflowError } from "@alineo-labs/core";

/** Memory capabilities a `Memory` instance may or may not have been configured with. */
export type MemoryCapability = "semantic";

/**
 * Thrown when a `Memory` method is called for a capability (e.g. semantic recall) that this
 * instance was never given a provider for. Deliberately loud — matching `errors.ts`'s existing
 * convention of distinguishable error classes (`CommandError`, `SandboxError`) callers can
 * catch specifically — rather than a silent no-op or an empty result set that looks
 * indistinguishable from "no facts matched."
 */
export class MemoryCapabilityError extends WorkflowError {
  constructor(public readonly capability: MemoryCapability) {
    super(`No ${capability} memory provider configured on this Memory instance.`);
    this.name = "MemoryCapabilityError";
  }
}

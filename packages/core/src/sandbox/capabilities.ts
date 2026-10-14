import type { ProviderCapabilities, SandboxProvider } from "@alineo-labs/provider";
import { SandboxError } from "../errors";

/** The capabilities a caller can require of a provider. */
export type RequiredCapability = keyof ProviderCapabilities;

/**
 * Throw `CAPABILITY_UNSUPPORTED`, naming the capability and the provider, when the provider
 * declares it cannot do something.
 *
 * Only an explicit `false` is a refusal. `"unverified"` (configured, not proven) goes ahead and
 * may still fail at the call, and a provider with no descriptor, which is what a test double
 * usually is, is not second-guessed.
 *
 * This is the early failure: a spec that needs egress, or a `checkpoint()` on a provider that
 * cannot snapshot, is refused before anything is created or sent, with a message that names the
 * missing capability instead of a failure three calls later that reads like a bad spec.
 */
export function requireCapability(
  provider: SandboxProvider,
  capability: RequiredCapability,
  sandboxId?: string,
): void {
  const declared = provider.descriptor?.capabilities?.[capability];
  if (declared !== false) return;
  throw new SandboxError(
    `The ${provider.id} provider does not support ${capability}`,
    sandboxId,
    "CAPABILITY_UNSUPPORTED",
    { details: { capability, provider: provider.id } },
  );
}

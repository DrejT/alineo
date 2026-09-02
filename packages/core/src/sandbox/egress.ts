import { EgressClient, type EgressPolicyStatus, type NetworkRule } from "@alineo-labs/opensandbox";
import { LedgerEvent } from "../ledger";
import type { SandboxInternal } from "./internal";

function client(sb: SandboxInternal): EgressClient {
  return new EgressClient(sb.deps.control, sb.deps.useServerProxy);
}

/**
 * Merge allow/deny rules into this sandbox's live egress policy. An incoming rule replaces
 * any existing rule with the same `target`; every other rule and the `defaultAction` are
 * untouched. The change is applied to the running sidecar immediately.
 *
 * Recorded to the ledger (the rules only, no secrets) so `Sandbox.resume()` can fold a
 * still-wanted change back into the resumed sandbox's boot policy — egress policy is
 * sidecar-local and does not survive a resume. (`sb.fork()` does not carry runtime egress
 * rules: a fork is a fresh branch and gets a wide-open `defaultAction: "allow"` policy.)
 */
export async function patch(sb: SandboxInternal, rules: NetworkRule[]): Promise<void> {
  await client(sb).patchRules(sb.sandboxId, rules);
  await sb.emit(LedgerEvent.EgressRuleAdded, -1, { rules });
}

/** Remove egress rules from this sandbox's live policy, by `target`. Unknown targets are ignored. */
export async function remove(sb: SandboxInternal, targets: string[]): Promise<void> {
  await client(sb).deleteRules(sb.sandboxId, targets);
  await sb.emit(LedgerEvent.EgressRuleRemoved, -1, { targets });
}

/** This sandbox's current egress policy, as the sidecar reports it. */
export async function get(sb: SandboxInternal): Promise<EgressPolicyStatus> {
  return client(sb).getPolicy(sb.sandboxId);
}

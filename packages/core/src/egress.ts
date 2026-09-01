import type { NetworkRule } from "@alineo-labs/opensandbox";
import { LedgerEvent } from "./ledger";
import type { LedgerEntry } from "./ledger";

/**
 * Reconstruct the egress rules that should still be applied to a resumed or forked sandbox,
 * from that session's ledger history. Egress policy is sidecar-local runtime state — it does
 * not survive the sidecar restarting and is not restored by OpenSandbox's snapshot/checkpoint
 * — so `Sandbox.resume()` and `sb.fork()` re-apply whatever `sb.egress.patch()` added and
 * `sb.egress.delete()` did not later remove.
 *
 * Keyed by `target` (the sidecar's own merge key): a later add for the same target wins, a
 * later delete drops it. Scans the whole history, like `reconstructBoundCredentials`.
 */
export function reconstructEgressRules(entries: LedgerEntry[]): NetworkRule[] {
  const byTarget = new Map<string, NetworkRule>();
  for (const entry of entries) {
    if (entry.event === LedgerEvent.EgressRuleAdded) {
      const { rules } = entry.payload as { rules: NetworkRule[] };
      for (const rule of rules) byTarget.set(rule.target, rule);
    } else if (entry.event === LedgerEvent.EgressRuleRemoved) {
      const { targets } = entry.payload as { targets: string[] };
      for (const target of targets) byTarget.delete(target);
    }
  }
  return [...byTarget.values()];
}

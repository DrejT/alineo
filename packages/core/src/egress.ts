import type { NetworkRule } from "@alineo-labs/opensandbox";
import { LedgerEvent } from "./ledger";
import type { LedgerEntry } from "./ledger";

/** The still-live outcome of a session's runtime `sb.egress.*` calls. */
export interface ReconstructedEgress {
  /** Rules to (re-)apply — a later add for the same target supersedes an earlier one. */
  apply: NetworkRule[];
  /**
   * Targets a `sb.egress.delete()` removed and no later `patch()` re-added — these must be
   * dropped from the resumed sandbox's boot policy too, not just from the runtime deltas
   * (a `delete()` of a rule that came from the *original* `networkPolicy` would otherwise be
   * silently undone on resume).
   */
  remove: string[];
}

/**
 * Reconstruct, from a session's ledger history, what its runtime `sb.egress.patch()` /
 * `sb.egress.delete()` calls still amount to. Egress policy is sidecar-local runtime state —
 * it does not survive the sidecar restarting and is not restored by OpenSandbox's
 * snapshot/checkpoint — so `Sandbox.resume()` folds this back into the resumed sandbox's boot
 * `networkPolicy`.
 *
 * Keyed by `target` (the sidecar's own merge key): a later add for a target wins; a later
 * delete removes it (and is reported in `remove` so a boot-policy rule can be dropped too);
 * a re-add after a delete brings it back. Scans the whole history, like
 * `reconstructBoundCredentials`.
 */
export function reconstructEgressRules(entries: LedgerEntry[]): ReconstructedEgress {
  const byTarget = new Map<string, NetworkRule>();
  const removed = new Set<string>();
  for (const entry of entries) {
    if (entry.event === LedgerEvent.EgressRuleAdded) {
      const { rules } = entry.payload as { rules: NetworkRule[] };
      for (const rule of rules) {
        byTarget.set(rule.target, rule);
        removed.delete(rule.target);
      }
    } else if (entry.event === LedgerEvent.EgressRuleRemoved) {
      const { targets } = entry.payload as { targets: string[] };
      for (const target of targets) {
        byTarget.delete(target);
        removed.add(target);
      }
    }
  }
  return { apply: [...byTarget.values()], remove: [...removed] };
}

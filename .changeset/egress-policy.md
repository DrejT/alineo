---
"@alineo-labs/opensandbox": minor
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
---

Egress network policy: CIDR/IP targets, and runtime policy changes on a live sandbox.

- **`NetworkRule.target` now documents (and the SDK validates) IP and CIDR targets** —
  `"10.0.0.5"`, `"10.0.0.0/8"`, plus IPv6 — alongside FQDNs and `*.` wildcards. IP/CIDR rules
  are enforced at the nftables layer (so they need `egress.mode = "dns+nft"`) and gate raw-IP
  egress only, not name resolution. A malformed `networkPolicy` target now throws
  `SandboxClientError` locally instead of failing on a server round-trip
  (`isValidEgressTarget` is exported from `@alineo-labs/opensandbox`).
- **`sb.egress.patch(rules)` / `sb.egress.delete(targets)` / `sb.egress.get()`** adjust a
  running sandbox's egress policy through its sidecar — merge in allow/deny rules (an incoming
  rule replaces any rule with the same `target`) or remove them by target. Changes apply
  immediately and are recorded to the ledger (`EgressRuleAdded` / `EgressRuleRemoved`), so
  `Sandbox.resume()` re-applies a still-wanted allowance — egress policy is sidecar-local and
  does not survive a resume on its own. New `EgressClient` in `@alineo-labs/opensandbox` and
  `reconstructEgressRules` in `@alineo-labs/core`.

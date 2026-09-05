---
---

Docs site only, no publishable package changes: document the 0.4.0 features that shipped
without docs.

- **New** `core/concepts/network-policy.mdx` — `networkPolicy` at sandbox creation,
  `NetworkRule` targets (FQDN / wildcard / IP / CIDR, and the `dns+nft` caveat), runtime
  `sb.egress.patch()` / `delete()` / `get()`, and the ledger/resume behavior.
- **New** `agent/getting-started/permissions.mdx` — the human-in-the-loop permission gate
  (`AgentSpec.permissions` modes + full `PermissionPolicy`, `resolvePermission()`,
  `prompt({ onPermission })`, `listPendingPermissions()`, the audit trail) and the
  approve-on-egress hold (`approval: "hold"`, `onEgressRequest`, `EgressApprovalGate`).
- **Fixed** `core/concepts/credentials.mdx` — the injection table said "header injection
  only" and still described the removed `query` / `path` shapes. Now documents
  `substitution` and links the migration.
- `agent/api-reference/agent.mdx` and `agent/getting-started/streaming.mdx` updated:
  `Alineo.load({ onEgressRequest })`, `prompt({ onPermission })`, the `permissions`
  `AgentSpec` field, the `permission_request` / `permission_resolved` events, and the new
  `agent.*` permission/egress methods.

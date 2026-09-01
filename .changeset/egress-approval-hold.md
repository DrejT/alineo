---
"alineo": minor
"@alineo-labs/sandbox": minor
---

Approve-on-egress hold for agents: `approval: "hold"` on a credential env binding.

A `CredentialEnvBinding` in `AgentSpec.env` can now carry `approval: "hold"`. The agent's
sandbox starts with that host **denied** at the egress sidecar (everything else, including the
agent's own model traffic, keeps working); the first outbound request to it pauses and calls
the `onEgressRequest` handler you pass to `Alineo.load()`, which returns `"allow-once"`
(reverted when the turn ends), `"allow-always"` (permanent for the agent's life), or
`"deny"`. Enforcement is entirely out-of-process at the sidecar — a compromised in-sandbox
agent cannot skip it.

- New `EgressApprovalGate` (exported from `alineo`): a small host-side listener for the
  sidecar's deny webhook that flips the rule via `sb.egress.patch()` on approval. `Alineo`
  starts one automatically for `hold` bindings and stops it on `close()`;
  `agent.pendingEgressRequests()` lists what is waiting. `agent.egressGate` is exposed for
  direct control. Ledger: `PermissionRequested` / `PermissionResolved` with `tool: "network"`.
- The webhook host defaults to the Docker bridge gateway (`172.17.0.1`); override via
  `ALINEO_EGRESS_APPROVAL_HOST` for other topologies.
- `@alineo-labs/sandbox`: `restoreSnapshot()` gains an `env` option (for re-supplying
  `OPENSANDBOX_EGRESS_*` sidecar vars on a restore — the sidecar is not snapshotted).

Deferred: the deny-webhook signal is not yet unified into the Pi tool-permission stream (so
network approvals do not appear in `listPendingPermissions()` alongside tool permissions or
in the chat UI), and there is no automatic re-run of the request that hit the denial — the
model retries on its own (the retry window is effectively instant). Both are follow-ups.

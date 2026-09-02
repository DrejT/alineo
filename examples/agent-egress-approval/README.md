# agent-egress-approval

A Pi agent whose outbound access to `api.github.com` is **held at the egress sidecar** until
an operator approves it — `AgentSpec.env` `approval: "hold"` + `Alineo.load({ onEgressRequest })`.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time), with egress.mode = "dns+nft"
export NVIDIA_API_KEY=...
export GITHUB_TOKEN=...   # optional — without it, approval still opens the host but no
                         # credential is injected, so the request goes out unauthenticated (401)
```

## Run

```bash
bun install
bun start
```

## What it shows

`agents/egress-agent.json` binds `GITHUB_TOKEN` to `api.github.com` with header injection **and**
`"approval": "hold"`. On `Alineo.load()`:

1. The sandbox is created `defaultAction: "allow"` with a single `deny` rule for
   `api.github.com` — everything else (npm, the model API, …) works normally.
2. A small host-side listener is started for the sidecar's deny webhook. `Alineo` stops it on
   `close()`.
3. The agent runs a `curl` to `api.github.com`. The sidecar denies the DNS query, POSTs the
   webhook, and `onEgressRequest({ host: "api.github.com" })` is called — this example returns
   `"allow-once"` (also available: `"allow-always"`, `"deny"`).
4. The listener flips the rule to `allow` via `sb.egress.patch()`. The retried request now
   resolves, and the sidecar injects the real `GITHUB_TOKEN` into it — the sandbox process
   never held the token.
5. `"allow-once"` is reverted to `deny` when the turn ends.
6. The ledger has `permission_requested` / `permission_resolved` rows (`tool: "network"`) for
   the audit trail. `agent.pendingEgressRequests()` reports anything still waiting.

The webhook host defaults to the Docker bridge gateway (`172.17.0.1`); set
`ALINEO_EGRESS_APPROVAL_HOST` for other topologies.

## Notes

Enforcement is entirely out-of-process at the egress sidecar — a compromised in-sandbox agent
cannot reach a held host until a human approves, regardless of what it does inside the sandbox.

---
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"alineo-cli": patch
---

Refuse, before anything is sent, what the provider has declared it cannot do.

- `requireCapability(provider, capability)` throws `CAPABILITY_UNSUPPORTED`, naming the capability
  and the provider. Only an explicit `false` is a refusal: `"unverified"` goes ahead and may still
  fail at the call, and a provider with no descriptor is not second-guessed.
- `sb.checkpoint()` and `sb.fork()` check `snapshot`, `sb.pause()` checks `pause`, and `sb.egress.*`
  checks `egress`.
- `Sandbox.sandbox()` refuses a `networkPolicy` with rules on a provider with no egress control and
  a `credentialProxy` on one with no credential injection, before a container exists.
- `Sandbox.provider` exposes the provider. `alineo agents` uses it to list live sandboxes, and
  `alineo-cli` no longer depends on `@alineo-labs/opensandbox`.

OpenSandbox declares egress and credentials as `"unverified"`, so nothing changes for it today.

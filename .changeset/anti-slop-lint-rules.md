---
"@alineo-labs/core": patch
"@alineo-labs/workflow": patch
"@alineo-labs/flue": patch
"alineo": patch
"alineo-cli": patch
---

Narrow a few parameter types to the `SandboxHandle` / `Alineo` members they actually use, so
callers (and tests) can pass a structural stand-in instead of a cast: `PiAdapter`'s
`install`/`configure`/`startBridge` take `PiSandbox`, `EgressApprovalGate.bind()` takes
`EgressApprovalSandbox`, the Flue `alineo()` factory takes `AlineoSandbox`, `flushOps()` takes
`SandboxLike`, and `collectReply()` takes `Pick<Alineo, "prompt">`. Every existing call site still
type-checks; there is no runtime change.

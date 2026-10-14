---
"@alineo-labs/provider": minor
"@alineo-labs/opensandbox": minor
---

Add `@alineo-labs/provider`: the interface a sandbox provider implements, and the provider-neutral
types it speaks in. `@alineo-labs/opensandbox` gains `OpenSandboxProvider`, which implements it.

- `SandboxProvider`: `createSandbox`, `getSandbox`, `listSandboxes`, `deleteSandbox`,
  `pauseSandbox`, `resumeSandbox`, `createSnapshot`, `getSnapshot`, `getEndpoint`, diagnostics,
  `connectExec`, and optionally `connectPty` and `egress`.
- States are `SandboxState`, a plain string union, not a provider's enum. A state a provider cannot place is
  `provisioning`, never `running`.
- `connectExec` resolves once the sandbox accepts a connection, and rejects with
  `EXEC_NOT_READY`, with the attempt count and the wait in `details`, when it never does.
- `ProviderDescriptor` declares what a provider can do as plain data.

Nothing consumes it yet. Core and the SDK move onto it next.

`CodeLanguage` is one definition now: a const object in `@alineo-labs/provider` (`CodeLanguage.Python`
and the type `CodeLanguage` both work), re-exported unchanged by `@alineo-labs/opensandbox` and
`@alineo-labs/sandbox`. It replaces OpenSandbox's enum of the same name.

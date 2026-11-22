# @alineo-labs/provider

## 0.1.0

### Minor Changes

- d55be76: Add `@alineo-labs/provider`: the interface a sandbox provider implements, and the provider-neutral
  types it speaks in. `@alineo-labs/opensandbox` gains `OpenSandboxProvider`, which implements it.

  - `SandboxProvider`: `createSandbox`, `getSandbox`, `listSandboxes`, `deleteSandbox`,
    `pauseSandbox`, `resumeSandbox`, `createSnapshot`, `getSnapshot`, `getEndpoint`, diagnostics,
    `connectExec`, and optionally `connectPty` and `egress`.
  - States are `SandboxState`, a plain string union, not a provider's enum. A state a provider cannot place is
    `provisioning`, never `running`.
  - `connectExec(sandboxId, { signal })` resolves once the sandbox accepts a connection, stops waiting
    when the signal aborts, and rejects with
    `EXEC_NOT_READY`, with the attempt count and the wait in `details`, when it never does.
  - `SandboxProviderDescriptor` declares what a provider can do as plain data.

  Nothing consumes it yet. Core and the SDK move onto it next.

  `CodeLanguage` is one definition now: a const object in `@alineo-labs/provider` (`CodeLanguage.Python`
  and the type `CodeLanguage` both work), re-exported unchanged by `@alineo-labs/opensandbox` and
  `@alineo-labs/sandbox`. It replaces OpenSandbox's enum of the same name.

### Patch Changes

- d55be76: Core and the SDK now run on a `SandboxProvider`, not on OpenSandbox's HTTP clients.

  - `@alineo-labs/core` no longer imports `@alineo-labs/opensandbox`. `SandboxDeps.control` is
    `SandboxDeps.provider`, and `SandboxDeps.useServerProxy` is gone (it is the provider's own
    setting). `SandboxState` (a string union) replaces OpenSandbox's state enums, and `ExecEvent` replaces `SSEEvent`.
  - `resolveExecClient(control, id, ...)` is replaced by `resolveExecChannel(provider, id)`. The
    provider owns the wait. An `EXEC_NOT_READY` from it is re-thrown as `ExecConnectionError`.
  - `sb.egress.*` and `exec(cmd, { interactive: true })` throw `CAPABILITY_UNSUPPORTED` on a
    provider that has no egress control or no terminal.
  - `Sandbox` takes an optional `provider`. `baseUrl` is optional when one is given. Without it,
    `baseUrl`, `apiKey`, and `useServerProxy` build an `OpenSandboxProvider`, so existing callers
    change nothing.
  - `@alineo-labs/vault` takes any object with a `getEndpoint` (`EndpointSource`), and no longer
    depends on `@alineo-labs/opensandbox`.

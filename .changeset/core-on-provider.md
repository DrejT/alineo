---
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"@alineo-labs/vault": minor
"@alineo-labs/provider": patch
---

Core and the SDK now run on a `SandboxProvider`, not on OpenSandbox's HTTP clients.

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

---
"@alineo-labs/errors": minor
"@alineo-labs/opensandbox": minor
"@alineo-labs/core": minor
"@alineo-labs/sandbox": minor
"alineo": patch
---

Add `@alineo-labs/errors`: stable error codes and an `AlineoError` base class.

Every error alineo raises on purpose now carries a `code` (`SANDBOX_NOT_FOUND`,
`EXEC_NOT_READY`, `PROVIDER_RATE_LIMITED`, and so on) plus `category`, `retryable`, `hint`, and
`details`. Branch on `code`, not on the class name or the message.

- `ExecConnectionError` keeps its name and leading message text, and now carries `cause`,
  `attempts`, and `waitedMs`, so a first-run failure says why execd never answered.
- `OpenSandboxError.code` is now the alineo code. OpenSandbox's own code
  (`DOCKER::SANDBOX_NOT_FOUND`) moved to `OpenSandboxError.upstreamCode`. This is a breaking
  change for anything that read the old `.code`.
- `WorkflowError`, `SandboxError`, `CommandError`, `StepTimeoutError`, and `SandboxClientError`
  extend `AlineoError`. `instanceof` and `err.name` are unchanged.
- `isSandboxGone` decides by code first and keeps the message match as a fallback.
- `@alineo-labs/core` re-exports `AlineoError`, `errorCodeOf`, and `isRetryable`.

# @alineo-labs/errors

## 0.1.0

### Minor Changes

- d55be76: Add `@alineo-labs/errors`: stable error codes and an `AlineoError` base class.

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

### Patch Changes

- d55be76: Carry error codes across the alineod wire.

  - `agent.ended`, `agent.turn_failed`, and `agent.supervision_needed` events gain an optional
    `errorCode` beside `error`. The old fields are unchanged.
  - alineod HTTP error bodies gain an optional `code` beside `error`. A response with no
    applicable code is unchanged.
  - A failure that arrives only as text, such as a model provider's `429`, is classified with
    `errorCodeFromText()` into `MODEL_RATE_LIMITED` or `MODEL_UNAVAILABLE`.
  - `alineo-cli` telemetry reports the alineo error code as `errorClass` when the error has one,
    and the class name otherwise.
  - `alineo-mcp` surfaces `code` on `AlineodError` and names it in a tool's error text.

- d55be76: Give the errors that had no code a code.

  - `AGENT_NOT_FOUND`, `RUN_NOT_FOUND`, `AGENT_NOT_LIVE` and `AGENT_BUSY` are new codes. alineod's
    404 and 409 answers for a missing agent, a missing run, an agent that is not live and an agent
    still finishing a turn now carry them in `code`. Its 400 validation answers carry
    `INVALID_ARGUMENT`, and a disabled memory store (501) carries `CAPABILITY_UNSUPPORTED`. Before,
    only an unhandled error that was already an `AlineoError` had a `code` on the wire.
  - A failure from the execd client (a command or a file call on a sandbox the server no longer
    has, a failed upload or download) is an `OpenSandboxError` with an alineo code and the upstream
    code in `.upstreamCode`. It was a plain `Error` whose message was the raw response body.

- d55be76: Record which sandbox provider owns each sandbox.

  - `sandbox.created` gains an optional `provider` (`"opensandbox"` today). A row with no
    `provider` means `"opensandbox"`. There is no migration: readers apply the default.
  - `SandboxDetails.provider` and `ListSandboxOptions.provider` (core). Both SQLite and Postgres
    adapters derive it from the `sandbox.created` payload, the same way they derive `runId`.
    `DEFAULT_PROVIDER_ID` is exported from core.
  - `Sandbox.resume()` throws `PROVIDER_MISMATCH` (409) when the session was created on another
    provider, instead of sending a sandbox id to a server that has never heard of it.
  - `AgentSnapshotStore` includes the provider in its key. OpenSandbox keeps the legacy key, so
    an existing `agent-snapshots.json` keeps working, and saving for one provider no longer
    deletes another provider's snapshot of the same spec.

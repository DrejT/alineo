---
"@alineo-labs/errors": patch
"@alineo-labs/opensandbox": patch
---

Give the errors that had no code a code.

- `AGENT_NOT_FOUND`, `RUN_NOT_FOUND`, `AGENT_NOT_LIVE` and `AGENT_BUSY` are new codes. alineod's
  404 and 409 answers for a missing agent, a missing run, an agent that is not live and an agent
  still finishing a turn now carry them in `code`. Its 400 validation answers carry
  `INVALID_ARGUMENT`, and a disabled memory store (501) carries `CAPABILITY_UNSUPPORTED`. Before,
  only an unhandled error that was already an `AlineoError` had a `code` on the wire.
- A failure from the execd client (a command or a file call on a sandbox the server no longer
  has, a failed upload or download) is an `OpenSandboxError` with an alineo code and the upstream
  code in `.upstreamCode`. It was a plain `Error` whose message was the raw response body.

---
"@alineo-labs/errors": patch
"@alineo-labs/schema": patch
"alineo-cli": patch
"alineo-mcp": patch
---

Carry error codes across the alineod wire.

- `agent.ended`, `agent.turn_failed`, and `agent.supervision_needed` events gain an optional
  `errorCode` beside `error`. The old fields are unchanged.
- alineod HTTP error bodies gain an optional `code` beside `error`. A response with no
  applicable code is unchanged.
- A failure that arrives only as text, such as a model provider's `429`, is classified with
  `errorCodeFromText()` into `MODEL_RATE_LIMITED` or `MODEL_UNAVAILABLE`.
- `alineo-cli` telemetry reports the alineo error code as `errorClass` when the error has one,
  and the class name otherwise.
- `alineo-mcp` surfaces `code` on `AlineodError` and names it in a tool's error text.

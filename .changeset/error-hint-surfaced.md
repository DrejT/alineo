---
"alineo-cli": patch
"alineo-mcp": patch
---

Show the `hint` of an error where a person reads it.

- The CLI prints `Hint: …` on its own line under the error message when the error carries one.
- alineod's HTTP error body gains `hint` beside `code`, for an unhandled error that has one.
- `alineo-mcp` tool errors end with a `Hint:` line when alineod sent a hint.

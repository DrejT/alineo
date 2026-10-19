---
"@alineo-labs/opensandbox": patch
---

Refuse a command over 92,000 bytes before it is sent. execd v1.0.22 ignores a command of about
100 KB or more: it answers exit 0 and runs nothing. `executeCommand()` now throws
`INVALID_ARGUMENT` with a hint to use `writeFile()`, and the request is not sent.

---
"@alineo-labs/opensandbox": patch
"@alineo-labs/core": patch
---

Stop reporting a command that never started as exit 0.

When execd cannot start a command it sends an `error` event whose `evalue` is a message
(`fork/exec /usr/bin/bash: argument list too long`), not an exit status. `ExecHandle` read only
numeric values, so the result stayed at its default exit 0 with no output. It is now exit 126,
with the message in `stderr`, so strict mode throws `CommandError`.

The usual cause is size. Linux allows 131,071 bytes in one argument, and `sb.exec()` sends the
command base64-encoded, so about 98 KB is the most it can carry. `ExecClient.executeCommand()`
now refuses a longer command before it sends it, with `INVALID_ARGUMENT` and a hint to use
`writeFile()`.

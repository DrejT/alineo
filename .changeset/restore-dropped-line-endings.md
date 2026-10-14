---
"@alineo-labs/core": patch
---

Restore line endings that `execd` before 1.1.1 dropped from stdout and stderr.

`execd` v1.0.22 sends one event per line with the newline removed, and `ExecHandle` joined the
events with `""`, so `echo one; echo two` returned `"onetwo"`. An existing install keeps the
`execd_image` in its `server.toml`, so changing the pin only reaches new installs.

`ExecHandle` now recognises the dropped-ending shape (at least two events, none containing `\n` or
`\r`) and rebuilds the text: `result.stdout`, `result.stderr`, and the chunks from `stdout()` and
`pipe()`. A server that keeps endings is untouched, a lone ending-less event is left as it is, and
PTY output is never rewritten.

One cost on an old server: `stdout()` holds an ending-less chunk until the next event arrives, so
a streamed line shows up one line late.

---
"@alineo-labs/opensandbox": patch
---

Restore line endings that `execd` before 1.1.1 dropped from stdout and stderr.

`execd` v1.0.22 sends one event per line with the newline removed, and `ExecHandle` joined the
events with `""`, so `echo one; echo two` returned `"onetwo"`. An existing install keeps the
`execd_image` in its `server.toml`, so changing the pin only reaches new installs.

`OpenSandboxProvider` now recognises the dropped-ending shape and restores the endings in command
and session output, before core sees it. Core joins events as they are.

A stream with two or more ending-less events of one kind and no event of that kind that has an
ending can only be a server that dropped them, so those events are held until the stream's terminal
event and released with `\n`. The first event that carries an ending proves the server keeps them:
nothing is held, and nothing is changed. A lone ending-less event, a trailing fragment, a line split
across events (`"abc"` then `"def\n"`), and `\r`-terminated progress output are all left alone.
Each channel learns once: after a stream has proved the server drops endings, later output is
repaired as it arrives and not held.

Limit: on a server that drops endings, a final fragment printed on purpose without a newline gets
one added once the channel has learned. The events alone cannot tell the two apart.

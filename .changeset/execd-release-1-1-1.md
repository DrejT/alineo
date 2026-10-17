---
"alineo-cli": patch
"alineo-mcp": patch
---

`alineo init` now pins `opensandbox/execd:release-1.1.1` instead of `v1.0.22`.

`v1.0.22` emits one stdout event per line with the newline stripped, so a multi-line command's
`ExecResult.stdout` lost its line breaks: `echo one; echo two` returned `"onetwo"`. From 1.1.1 the
event text keeps its newline. The post-completion delay on `/command` also drops from about 1 s to
about 0.2 s.

An existing install keeps the `execd_image` in its `~/.config/alineo/server.toml`. To get the fix,
change that line to `opensandbox/execd:release-1.1.1` and restart the OpenSandbox container.

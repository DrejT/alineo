---
"alineo-cli": patch
---

Fix `alineo spawn`/`fork`/`prompt` (and every other subcommand) hanging indefinitely instead
of exiting after printing their result. The underlying SDK's exec client keeps a connection
open on the `Agent`/`Sandbox` object to support further calls on it, which left the CLI
process's event loop non-empty forever -- every `--prompt --json` invocation needed an
external `timeout` wrapper to actually terminate. Calling `agent.close()` isn't the fix: `spawn`
and `fork` deliberately leave their sandbox running (that's the whole point -- `alineo agents`/
`alineo prompt <id>` interact with it afterward), so closing the `Agent` object would delete
the very sandbox the command just reported. Added an explicit `process.exit(0)` after a
subcommand completes instead -- it ends only this CLI invocation, with no effect on the
remote sandbox.

Verified via a real `alineo spawn ... --prompt ... --json` run: previously hung until killed
externally; now exits naturally within a second of printing its result (measured: total wall
time matched the CLI's own reported work duration almost exactly).

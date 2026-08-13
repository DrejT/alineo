---
"@alineo-labs/agent": patch
---

`Agent.prompt()`'s SSE stream had no timeout at all — if the underlying Pi process ever went
silent (the bridge's own keep-alive heartbeat kept the raw connection alive regardless), every
caller up the chain blocked forever with zero visibility. Added an inactivity timeout, keyed off
real `AgentEvent`s rather than raw stream activity so the heartbeat can't mask a genuine stall,
via a new `inactivityTimeoutMs` option (default 60s) and a new `PromptTimeoutError`. `alineo
fork`/`spawn`/`prompt --prompt` now also expose this as `--timeout SECONDS`, and their `--json`
output reports `toolCalls` alongside `reply` so a turn that made tool calls but produced no
final text isn't indistinguishable from one that did nothing at all.

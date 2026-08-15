---
"@alineo-labs/agent": patch
---

Raise `sseStream`'s default inactivity timeout from 60s to 3 minutes. Pi's own `bash` tool is
not incrementally streamed, so a single tool call that spins up a whole child sandbox (e.g. a
master session running `alineo fork` on itself, as in `examples/rlm-repo-fanout`) produces zero
`AgentEvent`s for as long as that call takes — child sandbox provisioning plus Pi CLI install
alone routinely took 30-150s+ in testing, regularly exceeding the old 60s default and killing
otherwise-healthy sessions mid-run. Confirmed via a real `examples/rlm-repo-fanout` run: the
exact `alineo fork` tool call that previously crashed the host script with `PromptTimeoutError`
at 60s now completes normally under the new default. Callers needing something tighter or
looser can still pass `inactivityTimeoutMs` explicitly to `prompt()`.

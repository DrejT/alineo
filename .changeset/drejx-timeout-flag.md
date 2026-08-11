---
"drejx": patch
---

`drejx fork`/`spawn`/`prompt` now accept `--timeout SECONDS` to bound how long a `--prompt`
waits for activity before failing with a clear error, instead of hanging forever if the
underlying agent process ever goes silent. `--json` output also now includes `toolCalls`
alongside `reply`, so a turn that made tool calls but produced no final text is distinguishable
from one that did nothing.

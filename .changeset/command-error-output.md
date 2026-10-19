---
"@alineo-labs/core": patch
---

`CommandError` now carries the command's output. Before, a failed `sb.exec()` reported only the exit code and the command, so the reason (for example an npm `ETARGET` error) was lost. The error has new `stdout` and `stderr` fields, and its message ends with the last 2000 characters of `stderr` (or `stdout` when `stderr` is empty).

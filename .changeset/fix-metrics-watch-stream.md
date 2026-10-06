---
"@alineo-labs/opensandbox": minor
"@alineo-labs/core": patch
---

Fix `SandboxHandle.watchMetrics()` / `ExecClient.watchMetrics()` never yielding any event against a real server: `parseSSE` only recognized `\n\n`-framed SSE, but execd's `/metrics/watch` emits single-`\n`-delimited raw JSON lines, and the `Metrics` type/field-name guard didn't match execd's actual payload shape.

**Breaking type change in `@alineo-labs/opensandbox`:** `Metrics` now matches what execd sends — `cpu_count`, `cpu_used_pct`, `mem_total_mib`, `mem_used_mib` and `timestamp: number`, replacing `cpu`, `memory` and `timestamp: string`. Verified against a real sandbox on 2026-10-06.

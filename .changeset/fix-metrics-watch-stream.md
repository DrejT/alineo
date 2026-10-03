---
"@alineo-labs/opensandbox": patch
"@alineo-labs/core": patch
---

Fix `SandboxHandle.watchMetrics()` / `ExecClient.watchMetrics()` never yielding any event against a real server: `parseSSE` only recognized `\n\n`-framed SSE, but execd's `/metrics/watch` emits single-`\n`-delimited raw JSON lines, and the `Metrics` type/field-name guard didn't match execd's actual payload shape (`cpu_count`/`cpu_used_pct`/`mem_total_mib`/`mem_used_mib`/`timestamp: number`, not `cpu`/`memory`/`timestamp: string`).

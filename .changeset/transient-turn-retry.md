---
"@alineo-labs/schema": patch
---

alineod re-sends a turn that failed on a transient model-provider error.

A turn that ends on a `429` or a `5xx` is now retried before the agent's `onFailure` policy runs: up
to `ALINEOD_TRANSIENT_RETRY_MAX` times (default `3`), with a doubling backoff from
`ALINEOD_TRANSIENT_RETRY_BASE_MS` (default 2 s, 25% jitter, capped at 30 s). Each retry emits a
new `agent.turn_retried` event and does not count toward the circuit breaker. Set
`ALINEOD_TRANSIENT_RETRY_MAX=0` to restore the old behavior.

In a 20-agent test on a 1 vCPU host, half the turns failed on `429` with no retry; with a
concurrency cap and retry, 19 of 20 succeeded.

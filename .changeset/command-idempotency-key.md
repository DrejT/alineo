---
"@alineo-labs/schema": minor
---

`ControlScopeBody` (pause/resume), `StopAgentBody`, and `SteerBody` gain an optional
`idempotencyKey` field, mirroring `SpawnAgentBody`'s existing one. A retried request with the
same key returns the original response instead of acting twice — `pause`/`resume`/`stop`/`steer`
previously had no protection against a lost-response retry double-acting. Scope: the named agent
only — a subtree op does not support per-request idempotency.

---
"@alineo-labs/schema": minor
---

**BREAKING:** remove the `StepCheckpointed` event definition (`step.checkpointed`) and the
`checkpoint → step.checkpointed` entry in the rename table. Nothing writes or reads this event.
It was the workflow's per-step resumption point, which an early version wrote and later versions
do not. The matching `LedgerEvent.Checkpoint` member in `@alineo-labs/core` was already removed.

A store may still hold rows named `checkpoint`. The one-time rename no longer touches them.

---
"@alineo-labs/core": minor
---

**BREAKING:** remove nine `LedgerEvent` members that nothing in alineo emits or reads:
`RunStarted`, `StepStart`, `StepComplete`, `StepFailed`, `StepRolledBack`, `WorkflowComplete`,
`WorkflowFailed`, `Checkpoint`, and the deprecated `Snapshot`.

Workflow event names (`workflow.started`, `step.started`, and the rest) are defined in
`@alineo-labs/schema`, not in this enum. Use `LedgerEvent.CheckpointCreated` in place of
`LedgerEvent.Snapshot`.

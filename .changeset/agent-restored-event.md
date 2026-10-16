---
"alineo": minor
"@alineo-labs/schema": minor
---

A restore from a gone container now says what it restored. alineod emits `agent.restored` with `oldSandboxId` and `checkpointTurn` right after `agent.provisioned`. `checkpointTurn` is `null` when the agent had no checkpoint and came back with a blank session. Before this, a restore from a checkpoint and a restore with nothing looked the same in the event stream.

The SDK adds `Alineo.restore` (`{ checkpointTurn: number | null }`), set by `resume()` and `reattach()` when they return an agent on a fresh sandbox, and the `AgentRestore` type.

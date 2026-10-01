---
"@alineo-labs/schema": minor
---

`AgentSpec` gains `onFailure?: "ask" | "retry" | "fail"`, `maxRetries?: number`, and
`maxConsecutiveFailures?: number` — a unified policy for what happens when a turn fails,
replacing the separately-proposed `onInterrupt` field before it was built twice under two names.
Default is `"fail"` (unchanged from today's behavior — supervision is opt-in). Two new events:
`agent.turn_failed`, `agent.supervision_needed`. `InboxQueued`'s `kind` enum gains `"supervision"`
for the automatic (non-opt-in) parent notification.

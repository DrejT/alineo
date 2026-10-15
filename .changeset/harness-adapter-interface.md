---
"alineo": minor
---

Put Pi behind a harness-neutral interface, so a second harness can sit beside it.

- `HarnessAdapter`, `HarnessEvent` and `HarnessCapabilities` are new and `@experimental`.
  `createHarness(id)` is the one place an adapter is built. `FakeHarness` is an in-memory
  adapter for tests.
- `agent.harness("pi")` returns Pi's own adapter, for what only Pi has.
- `exportHtml`, `cycleModel`, `cycleThinkingLevel`, `getCommands`, `setSteeringMode`,
  `setFollowUpMode`, `setSessionName`, `setAutoRetry`, `abortRetry`, `abortBash`,
  `setAutoCompaction` and `bash` are deprecated on `Alineo`. They still work. Use
  `agent.harness("pi").<method>()`.
- **Breaking:** `agent.adapter` is typed `HarnessAdapter`, not `PiAdapter`. Use
  `agent.harness("pi")` for Pi's methods.
- **Behavior:** `agent.steer()` with no turn running now throws `no turn in progress`. Before, Pi
  queued the message for whatever turn came next. A steer sent while a turn runs is unchanged.
- `prompt()` still yields `AgentEvent`, and a failed turn still throws the original error.

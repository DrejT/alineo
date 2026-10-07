---
"@alineo-labs/schema": minor
"alineo-mcp": minor
---

Add `closeWhen` to a run (plans/07-10-2026/close-when.md). `POST /runs` accepts
`closeWhen: "explicit" | "quiescent"` (default `"explicit"`, today's exact behavior — a run
stays open until a client deletes it). A run created with `closeWhen: "quiescent"` closes
itself, with no client call, the moment every agent in it is terminal and has nothing left to
deliver — alineod now tracks each run's open/closed state (a new `runs` projection table,
folded from the new `run.closed` event) and reacts to it.

New in `@alineo-labs/schema`: `CloseWhen`, the `closeWhen` field on `CreateRunBody` and
`RunStarted`, the `RunClosed` event, and `closeWhen`/`state` on `TreeView` (`GET /runs/:id`).

New in `alineo-mcp`: `run_start`'s `closeWhen` parameter, passed straight through to alineod.

Also fixes a correctness gap in `apps/alineod`'s existing quiescence detection
(`GET`/`POST /runs/:runId/await`, used by both the bare `closeWhen: "quiescent"` path and
anyone already polling it): a `done`/`failed` member holding a pending inbox entry (held for
its next prompt — not the same as a `paused` member, which was already excluded) could read as
quiescent, even though something is still waiting to be delivered to it. `quiescence()` now
requires a member's pending inbox to be empty too, not just its state to be terminal.

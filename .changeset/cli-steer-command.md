---
"alineo-cli": minor
---

New `alineo steer <sandbox-id> <message>` — redirect a running session without restarting it.
Uses the new `Alineo.reattach()` (see the sibling `alineo` changeset), so a mid-turn session
isn't interrupted the way `alineo prompt` (which goes through `Alineo.resume()`) would. Meant
to be run by one session to redirect another it doesn't own the control plane for — a parent
redirecting a child it forked being the common case.

Pi extension guidance (`pi-extension/alineo.ts`) updated to mention it alongside `fork`/
`prompt`/`kill`, including the timing caveat: steer lands after the target's current tool call
finishes, before its next decision — it does not interrupt work already in progress. Use
`alineo kill` instead for an immediate stop.

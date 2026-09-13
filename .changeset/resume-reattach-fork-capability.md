---
"alineo": patch
---

Fix `Alineo.resume()` (and the new `Alineo.reattach()`) losing the ability to `.spawn()`
children. `client.connect()`'s `fork` dependency is only wired up when `resources` is passed
to it — `resumeAgent()` never passed it, so any agent reconnected via `resume()` (or
`reattach()`) threw `"fork() is not supported on this sandbox"` on its first `.spawn()` call.
Both now pass `spec.resources` (falling back to `alineo.config.json`'s `defaults.resources`,
same as `Alineo.load()`), so a resumed or reattached agent can keep spawning children exactly
as it could before the reconnect.

Found by testing `Alineo.reattach()` (see the sibling changeset) against a multi-agent tree
where a reconnected root needed to spawn a child that had been queued behind it at crash time.

---
"@alineo-labs/core": patch
---

Increase `resolveExecClient()`'s default retry budget from ~11s (15 retries, capped at 1s) to
~80s (45 retries, capped at 2s). A live `alineo fork` failure (issue #32) showed a child forked
while its parent sandbox was busy running a real Chrome session took ~35s just to reach
`Running`, then immediately exhausted the old budget before execd inside it had started
accepting connections. An isolated repro of the identical fork from an idle parent (no
concurrent browser load) reached execd-ready in under 400ms — the parent's own host-resource
contention at fork time, not snapshot size, is what actually eats the budget, and that can't be
scheduled around from here. Affording substantially more patience before giving up is the fix.

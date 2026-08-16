---
"alineo-example-rlm-repo-fanout": patch
---

Fix the evidence-verification step crashing with `PiAdapter: bridge not started`. It called
`child.bash(...)` on an `Agent.attach()`-returned agent — but `attach()` deliberately never
starts the Pi bridge (see its own doc comment), so `.bash()`/`.prompt()` were never available
on it. Switched to sourcing `/etc/alineo-env` over the plain `sandbox.exec()` API (already used
successfully one line above, for the repo-HEAD check), which inspects the exact same
environment the bridge would have started Pi with, without needing it running.

Verified via a real end-to-end run: the verification step for a spawned child now runs to
completion instead of crashing the whole script.

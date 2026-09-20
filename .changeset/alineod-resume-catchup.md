---
---

alineod only (private app), no publishable package changes. Crash recovery: an agent that was mid-turn when alineod went down and whose bridge process had also died (so `reattach` failed and `resume` restarted it) stayed `running` forever — nothing followed the turn that died with the old bridge. Startup now runs the same catch-up poll after a resume as after a reattach, so the handle settles (`failed` with "catch-up: no retrievable result", or `success` if partial text survived) instead of the agent showing `running` indefinitely.

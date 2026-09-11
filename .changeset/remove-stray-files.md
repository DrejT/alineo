---
---

Repo hygiene only, no publishable package changes: remove `.claude/launch.json` (a
personal dev launch profile for `apps/docs`, not needed checked in) and the stray
root `openapi.json` (125KB, unreferenced by any script or config — looks like a
generated artifact that was accidentally committed).

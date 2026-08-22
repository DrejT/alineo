---
---

Docs site only, no publishable package changes: retroactively fix the doc version
split. #175's original v0.1 content was later edited in place for the alineo/agent
naming inversion (#182) instead of being version-cut — so the "v0.1" folder actually
described 0.2.0's API, and no real pre-rename snapshot existed anywhere but git
history. Moved that (correct, current) content to content/docs/{core,alineo}/v0.2,
and restored the true pre-rename content (from git history just before the
in-place edit) as content/docs/{core,alineo}/v0.1, fixing each folder's internal
links to match. The version switcher now shows both versions with 0.2 marked
"latest"; unversioned aliases (/docs/core, /) redirect to 0.2.

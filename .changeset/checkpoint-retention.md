---
"alineo": minor
---

Add checkpoint retention (durability-roadmap.md M3, chunk 3.5). `takeCheckpoint()` now prunes
a sandbox's own checkpoint directory down to the newest `DEFAULT_CHECKPOINT_RETENTION` (3)
files after every successful write — restore (3.3) only ever reads the latest one, so older
checkpoints are just disk use with no live purpose. Sorted by file mtime (set at write time,
monotonic regardless of process restarts), not by the `turn` number embedded in the filename,
since `turn` resets to 0 across a resume/reattach.

Overridable per call via `takeCheckpoint(sb, dir, { turn, retain })`. A pruning failure is
swallowed, not thrown — the checkpoint the call was actually for already succeeded, and a
cleanup failure must never retroactively turn that into an error.

---
"@alineo-labs/core": patch
"@alineo-labs/schema": patch
"alineo": minor
---

Add turn-level checkpointing (durability-roadmap.md M3, chunk 3.2) — opt-in via
`AgentSpec.checkpoint: true`. After every turn that genuinely finishes (never one alineod
gave up waiting on, even if recorded as a success from leftover partial text — that doesn't
mean the session file finished flushing), alineod tars the agent's workspace + Pi session file,
stores it on disk, and records a new `agent.checkpointed { turn, snapshotRef }` ledger event —
written only once the tarball is confirmed stored, since an event with no file behind it is
unreachable garbage.

New in `@alineo-labs/core`: `LedgerEvent.AgentCheckpointed`, and `SandboxHandle.readFileBytes()` —
a byte-safe file read (no `TextDecoder`) for binary content like a gzip tarball, which the
existing `readFile()` would corrupt.

New in `alineo`: `takeCheckpoint()`, `checkpointsPath()`, `CHECKPOINT_ROOT`, and
`DEFAULT_CHECKPOINT_EXCLUDES`, exported as public API for a standalone SDK caller to use
directly (`alineo` gets a `minor` bump for this — pre-1.0, so a public API addition is a
`minor`, not `major`, per the project's own versioning convention).

Deliberately not `sb.checkpoint()` — that calls OpenSandbox's own snapshot primitive, which on
the Docker runtime is literally `docker commit` (confirmed against OpenSandbox's source,
M3's 3.1 research) and measured at 44.3s for a 236MB container. This mechanism tars a few
directories via `sb.exec()` instead, measured at well under 2s even unfiltered.

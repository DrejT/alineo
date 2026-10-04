---
"@alineo-labs/core": patch
"alineo": minor
---

Add resume-from-checkpoint (durability-roadmap.md M3, chunk 3.3). `Alineo.resume()` and
`Alineo.reattach()` now fall through to provisioning a fresh container from the cached setup
snapshot and restoring the latest turn checkpoint into it (3.2) when the sandbox itself is gone
entirely — not just unreachable. Previously both only ever called `client.connect()` against
the existing sandbox and threw if it was gone, with no fallback at all.

New in `alineo`: `isSandboxGone()` (promoted from `apps/alineod`'s own private copy and
extended — it now also recognizes an `Exited`-after-reboot container, a `200 OK` with `state:
"Terminated"`/`"Failed"`, not only a 404), `findLatestCheckpoint()`, `restoreCheckpoint()`.

New in `@alineo-labs/core`: `SandboxHandle.writeFileBytes()` — the write-side counterpart to
3.2's `readFileBytes()`, byte-safe for uploading binary content (a gzip tarball) that
`writeFile()`'s string-typed signature isn't safe for.

If the agent was never checkpointed, falls back to a fresh (blank) session rather than failing —
losing the conversation is still better than losing the agent. Known gap: a spec with
`approval: "hold"` credential bindings isn't restorable through this path yet (`resumeAgent`/
`reattachAgent` don't accept an `onEgressRequest` handler).

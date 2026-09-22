---
"alineo": minor
---

**BREAKING:** four `Alineo` methods are renamed so that one word means one thing across the
CLI, the SDK and the daemon.

| Before | Now | Why |
|---|---|---|
| `Alineo.load(spec, opts)` | `Alineo.start(spec, opts)` | "load" reads like parsing a file. It provisions a container and a harness — and takes ~90s the first time. |
| `agent.fork(entryId)` | `agent.branchSession(entryId)` | it branches a **conversation** and never leaves the container |
| `agent.clone()` | `agent.duplicateSession()` | same — unqualified `clone` reads like a sandbox operation |
| `agent.getForkMessages()` | `agent.getBranchPoints()` | it returns where a conversation can branch, and feeds `branchSession()` |

`fork` was doing three jobs: `sb.fork()` copies a filesystem, `agent.fork()` branched a Pi
conversation, and the CLI's `alineo fork` was really a spawn. It now means exactly one thing —
the sandbox-level copy — and `sandbox.fork()` is unchanged.

The Pi adapter keeps Pi's own names (`/fork`, `/clone` are its bridge endpoints). The adapter
speaks the harness's vocabulary; alineo speaks its own on the way out.

No aliases, per the same reasoning as the CLI rename: `Alineo.load` is gone rather than
deprecated, so an upgrade fails at the type level instead of at runtime.

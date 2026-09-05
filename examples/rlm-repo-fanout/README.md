# rlm-repo-fanout

The showcase example for `plans/alineo-rlm-substrate.md`: a master agent clones
a repo, decides how to split a task across it, and forks child agents — via
`alineo fork`, built on `Alineo.spawn()` — that each work on one slice starting
from the _exact same checked-out commit_ as the master, not a fresh clone.
This is the "shared live state" fan-out shape (pattern b in the plan), the
one that needed new plumbing beyond what `alineo spawn` already gave for free.

See `RUBRIC.md` for the full gate-by-gate evidence packet against the
[RLM rubric](https://github.com/rawwerks/recursive-coding-agents/blob/main/rlm-rubric/rlm-rubric.md).

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

Needs `NVIDIA_API_KEY` **in the repo root `.env`** — Bun only loads `.env`
from the shell's CWD at invocation, not by walking up to the repo root, so
this must be run as `bun examples/rlm-repo-fanout/index.ts` from the repo
root, not from inside this directory (the script checks for this and
refuses with a clear error otherwise). The worker uses NVIDIA NIM's
`nvidia/nemotron-3.5-lightning-30b-a3b`. The models the `RUBRIC.md` "Why
this model" benchmark originally settled on (`nvidia-nemotron-nano-9b-v2`
for the master, `nemotron-3-nano-30b-a3b` for the worker) have since
reached end-of-life on the NIM API; the master spec still pins the former
pending a re-benchmark.

`index.ts` defaults `MASTER_AGENT_OPENSANDBOX_DOMAIN` to `172.17.0.1:8080`
(the default Docker bridge gateway — the address a container uses to reach
services running on the host) if unset — this is the address the master's
own sandbox uses to reach the OpenSandbox server when it calls
`alineo fork` on itself. If your OpenSandbox server isn't reachable there
(a non-standard Docker network, a remote server, etc.), override it:

```bash
export MASTER_AGENT_OPENSANDBOX_DOMAIN=<your-routable-host:port>
```

An unset _and unreachable_ value fails silently rather than loudly — the
server URL baked into the sandbox becomes the literal broken string
`"http://"` (no host), and `alineo fork` fails with "Unable to connect"
rather than a clear config error.

See `examples/pi-agent/test-spawn-child.ts` for the two things that have to
be true for a container to reach the server at all.

**Note on `alineo fork` itself**: as of this writing, making `alineo fork`
(named `alineo spawn` before a later CLI rename) work when called from
_inside_ the sandbox it's forking from (rather than from a host process)
required two fixes in `packages/agent`/`packages/cli` — see `RUBRIC.md`'s
debugging history, items 12–13. Those fixes aren't in a published
release yet (see `.changeset/spawn-self-attach-fix.md`),
so a live run of this example won't successfully fork a child until that
release ships — the master's setup step installs `alineo` from npm, which
won't have the fix until then.

## Run

```bash
bun examples/rlm-repo-fanout/index.ts
```

## What it does

1. Loads the master agent (`agents/master.json`) — its setup steps clone this
   repo, install the `alineo` CLI, write `alineo.config.json` so `alineo` can
   reach the OpenSandbox server from inside the container, add a worker spec,
   and write `TASK.md` (the actual goal — see below).
2. Sends the master one short prompt: "read TASK.md and do it." The goal
   itself lives in a file, not in the prompt string (G2 — externalized
   context, not pasted into the root context).
3. The master is expected to inspect the repo, decide how many children to
   fork and how to split the work (G6 — left to the model, not scripted),
   then loop `alineo fork rlm-fanout-master ./agents/worker.json --prompt
"<slice>" --json` once per slice (G5 — code inside the sandbox calling
   sub-agents over constructed slices, not the master verbally asking a tool).
   Each forked child starts from the master's exact live filesystem —
   same commit, same working tree.
4. Each child writes its one file, runs `git diff`, and reports the diff as
   its own final answer (G7 — the artifact stays as a file; only the diff
   text, not full repo contents, comes back to the master).
5. The master combines the diffs it collected and reports the patch set as
   its own final answer. It does not apply, commit, or push anything —
   neither does any child.
6. The script then independently verifies the run — not just believes the
   model's summary. See `RUBRIC.md` for exactly what's checked and why.

## The task

`TASK.md` (baked into the master's sandbox by a setup step — see the file in
this directory for the exact text): find every `examples/*` folder in the
cloned repo missing a `README.md`, and have forked children write the
missing ones, each describing what that example demonstrates based on its
`index.ts`.

This isn't the point of the exercise — it's a task that's cheap, safe (never
touches this actual repository, only sandboxed clones), and naturally
decomposes into an unpredictable number of independent slices, which is
exactly what's needed to observe G6 honestly.

## Cleanup

The script closes the master and every child sandbox it finds in a `finally`
block, whether the run passed or failed.

## Known limitations

- `alineo fork`'s two fixes (self-identification via `ALINEO_SANDBOX_ID`, and
  `Alineo.attach()`'s self-connect) aren't published to npm yet — see the
  setup note above and `RUBRIC.md`'s debugging history for the full story.
- Model-driven runs can still fail on ordinary model noise (e.g. a typo like
  `trejx` instead of `alineo`) unrelated to any of the fixes above — that's
  expected variance, not a structural issue.

`Alineo.spawn()`'s own mechanism (fork, env-leak fix, depth injection,
depth-zero refusal) is independently, thoroughly verified via `.bash()` and
direct SDK calls — see `plans/alineo-rlm-substrate.md`'s test notes and
`RUBRIC.md`'s "Debugging history" section for the complete chain of bugs
found and fixed getting a live run working end to end.

# RUBRIC.md — evidence packet

Self-graded against the [RLM
rubric](https://github.com/rawwerks/recursive-coding-agents/blob/main/rlm-rubric/rlm-rubric.md)
(G1–G7). Structured the way the rubric itself asks evidence to be presented:
run shape, then per-gate evidence, then the strongest case against, then
what would change the verdict. See `plans/alineo-rlm-substrate.md` for the
full design rationale this example implements.

## Run shape

- **Entry point**: `bun examples/rlm-repo-fanout/index.ts`.
- **Master spec**: `agents/master.json` — Pi CLI, NVIDIA NIM's
  `nvidia/nvidia-nemotron-nano-9b-v2` (chosen after benchmarking several
  NVIDIA NIM models for speed/reliability/tenacity — see "Why this model"
  below), `spawnDepth: 1`. No `alineo_*` Pi tools registered (PR #124's
  extension is deliberately absent — see "Why no Pi tools" below).
- **Master's actual prompt**: one sentence — "Read ./TASK.md in your working
  directory and complete the task described there. Report a summary...". The
  task itself lives in `TASK.md`, written by a setup step baked into the
  snapshot, never pasted into the prompt string.
- **Worker spec**: `agents/worker.json` — Pi CLI only, `nvidia/nemotron-3-nano-30b-a3b`
  (faster than the master's model — a worker's task is a single bounded edit,
  not multi-step decomposition, so speed matters more than tenacity here). No
  `alineo` install, no `alineo.config.json`, no fork tools of any kind reachable.
- **Tools enabled for the master**: Pi's built-in bash tool only. `alineo` is
  a CLI on `$PATH` inside the sandbox, invoked the same way `ls` or `git`
  would be — not a registered tool the model calls by name.
- **Tools enabled for a worker**: Pi's built-in bash + file tools. No `alineo`
  binary present at all.

## Per-gate evidence

| Gate                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** — model-call outer shape                      | `master.prompt(...)` in `index.ts`: one prompt in, streamed text out. Unchanged from `alineo spawn --prompt`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G2** — context externalized as symbolic state      | The goal is `TASK.md`, a file written by a setup step (see `agents/master.json`'s `setup`), not string-interpolated into the prompt. The prompt only names the file.                                                                                                                                                                                                                                                                                                                                                                           |
| **G3** — root model has handles to that state        | The master reaches `TASK.md` via a path (`./TASK.md`) and reaches each child via a session name (`rlm-fanout-master` → forked child's own ledger name), not by having content pasted at it.                                                                                                                                                                                                                                                                                                                                                    |
| **G4** — persistent executable environment           | The whole run is one OpenSandbox sandbox per agent — filesystem, installed packages (`git`, `alineo`), and the cloned repo all persist across every tool call in a turn. This is what a alineo sandbox already is.                                                                                                                                                                                                                                                                                                                             |
| **G5** — code calls sub-LMs over constructed slices  | The master's own bash tool runs `alineo fork rlm-fanout-master ./agents/worker.json --prompt "<slice>" --json` in a loop it writes itself — a script inside the sandbox calling `Agent.spawn()` (via the CLI) over a constructed per-file instruction, not the master verbally invoking a registered typed tool. Verified in `index.ts`: every forked child found via the control plane has the master's exact `git rev-parse HEAD` — proof the child is a _fork_ of live state, not an independent `alineo spawn` from a spec's own snapshot. |
| **G6** — model decides the decomposition             | `TASK.md` says "decide how to split the work" and never states a child count or a fixed loop. `index.ts` asserts only "at least one child was spawned," not an exact number — the actual count is the model's call, whatever it turns out to be for a given run.                                                                                                                                                                                                                                                                               |
| **G7** — intermediate state stays in the environment | Each child's result is its own `git diff` output inside its own sandbox, reported back as that child's _own_ final answer (short diff text, not the full edited file re-pasted into the master's context) via the same `alineo fork ... --prompt ... --json` call that forked it.                                                                                                                                                                                                                                                              |

## Independent verification (what `index.ts` actually checks, not what the model claims)

- Every spawned child's `repo` is at the master's exact `git rev-parse HEAD`
  (G5's actual mechanism, not the model's description of it).
- A master-only secret (`RLM_FANOUT_SECRET`, generated fresh per run) is
  genuinely absent from a spawned child's real Pi/bridge environment —
  checked via the child's own bash tool, i.e. inside the same process tree
  Pi itself uses, not a raw `exec()` session that wouldn't prove anything
  about what Pi can see.
- A spawned child's `ALINEO_SPAWN_DEPTH` is exactly `"0"` — present and
  zeroed, not merely absent.
- A spawned child has no `alineo` binary on `$PATH` at all — a second,
  structural negative control: even ignoring the depth check, a worker
  cannot invoke `alineo spawn` because the command doesn't exist for it.
- The master's own `repo` HEAD is unchanged after the run — no commit was
  made, matching "report only" scope.

## Why no Pi tools

`packages/cli/pi-extension/alineo.ts` (PR #124) used to register `alineo_run` /
`alineo_prompt` / `alineo_agents` / `alineo_kill` as callable tools — useful for
a one-off "spawn a helper" UX, but structurally a parent _verbally_ deciding
"call this tool," which the rubric explicitly disqualifies for G5. Leaving
those tools out of `master.json` entirely meant every spawn in a real run of
this example was provably a bash/script invocation, not a tool call — there
was nothing else the model _could_ have used. Those typed tools have since
been removed from the extension entirely (issue #21 Bug B — the asymmetry
between them and the always-bash-only `alineo fork` measurably steered a
model toward the wrong primitive elsewhere), so this is no longer a
per-example opt-out; it's now true of every alineo-based spec by default.

## Why this model

Benchmarked several NVIDIA NIM models locally first (`pi -p --provider
nvidia --model <id> ...`, outside any sandbox — a plain text prompt and a
single bash-tool-calling prompt, timed):

| Model                               | Text        | Tool call                                  | Verdict                                                        |
| ----------------------------------- | ----------- | ------------------------------------------ | -------------------------------------------------------------- |
| `openai/gpt-oss-20b`                | 3.5s        | 2.5s (2.1–2.3s over 3 repeats)             | Fastest single-call — but see below                            |
| `nvidia/nemotron-3-nano-30b-a3b`    | 8.3s        | 3.6s                                       | Clean tool calls, but see below                                |
| `meta/llama-3.1-8b-instruct`        | 2.8s        | 6.9s                                       | Clean names, malformed `timeout` arg — see below               |
| `nvidia/nvidia-nemotron-nano-9b-v2` | 4.5s        | 11.7s                                      | Slower per call, but see below — **used for the master**       |
| `nvidia/nemotron-3-super-120b-a12b` | 5.7s        | 8.6s                                       | Slower per call, corrupted tool calls in real runs — see below |
| `qwen/qwen3.5-122b-a10b`            | 1.9s        | **error** — "Unexpected end of JSON input" | Broken tool calling through NVIDIA's endpoint — avoid          |
| `meta/llama-3.3-70b-instruct`       | **timeout** | **timeout**                                | Unreliable — avoid                                             |

That single-call benchmark turned out to be an incomplete signal twice over —
first for tool-call _correctness_ under Pi's parser, then for task-following
_tenacity_ across a long multi-tool-call session. Five distinct corruption or
reliability problems showed up only in real sandboxed multi-turn runs, one
per model tried, before landing on a model with none of them:

- **`openai/gpt-oss-20b` leaks its own "harmony" chat-template channel
  tokens into tool names** (`bash<|channel|>commentary`, `bashcommentary`)
  on roughly half its tool calls when served through NVIDIA — every one of
  those calls fails before the tool even runs, since the mangled name
  doesn't match anything registered. Fastest per-call, but unusable for a
  sustained session. Likely a template mismatch specific to NVIDIA serving
  an OpenAI-family model, not something wrong with gpt-oss itself.
- **`nvidia/nemotron-3-nano-30b-a3b`** (a native NVIDIA model, so no
  cross-vendor template mismatch) had completely clean tool calls, but
  showed real run-to-run variance in _tenacity_ — some runs explored the
  repo thoroughly and attempted a real `alineo spawn` call, others gave up
  after two tool calls without trying. Good for the worker's single bounded
  edit; not reliable enough for the master's longer decomposition work.
- **`nvidia/nemotron-3-super-120b-a12b`** showed the most persistent
  multi-turn behavior of the models tried before it — including
  self-recovering from a missing `bun` runtime by installing it unprompted
  — but its own reasoning text and a nested second tool-call attempt
  repeatedly bled into the _first_ call's command argument string in live
  runs (`"ls.\n\nWe need to use alineo spawn command...<tool_call>\n<function=bash>\n<parameter=command>\nls -la"`),
  producing an unparseable shell string and ending the turn early.
- **`meta/llama-3.1-8b-instruct`** had clean tool _names_ but reliably sent
  its bash tool's `timeout` argument as the string `"null"` instead of a
  number or an omitted field, failing Pi's schema validation
  (`timeout: must be number`) on nearly every call.
- **`nvidia/nvidia-nemotron-nano-9b-v2`** — initially benchmarked as merely
  "OK, slower tool calls" and not tried live until every faster option above
  had a confirmed correctness problem — turned out to have zero structural
  tool-call corruption across every multi-turn stress test: correct absolute
  paths, one call at a time (never blind-batched, unlike `llama-3.1-8b`,
  which fired 5–6 tool calls before any result came back, causing race
  failures), and it self-corrected a real mistake (a relative path in a
  generated Python script) using the `edit` tool and re-ran successfully,
  unprompted. Slower per call than several alternatives, but the only model
  tried that never corrupted a tool call across many multi-turn runs. Used
  for the master; the worker keeps `nemotron-3-nano-30b-a3b` since its job
  is one bounded edit, not open-ended decomposition.

## Strongest case against

- **G6 is only as honest as the task.** `TASK.md` does say "decide how to
  split the work," but a model that reliably treats "backfill missing
  READMEs" as one atomic slice (spawning exactly one child, or zero) would
  technically still pass G5 while giving weak G6 evidence. The rubric asks
  for decomposition to be genuinely model-chosen, not for the model to
  choose _well_ — a single-child run is still a real decomposition decision
  (the model considered splitting further and declined), but it's a weaker
  demonstration than a multi-child run.
- **The task itself is deliberately small and safe.** Real recursive coding
  agent workloads (per the rubric's own framing) look more like large,
  genuinely-parallel refactors. This example proves the _mechanism_ cleanly
  but at a scale chosen for cheap, reliable CI runs, not for representing the
  hardest real-world case.
- **G4's "environment" is Pi's bash tool, not a general code-execution
  substrate the model programs against directly.** The rubric's strongest
  framing of G5 (per its own text) is code written _in_ the environment
  calling submodels — here that code is a bash loop the model writes and
  runs via its bash tool, which does satisfy the letter of G5 (programmatic,
  not verbal) but is a shell script, not, say, a Python program constructing
  API calls. Worth being explicit that "bash tool calling a CLI in a loop"
  is the specific shape being claimed as sufficient, not asserting some
  stronger claim than that.

## What would change the verdict

- If `alineo spawn`'s depth/env checks were found to be bypassable (e.g. a
  worker could still reach a `alineo` binary through some path not covered by
  `agents/worker.json`'s scoping), G5's isolation claim would need to be
  re-verified live again, the same way the original leak was found.
- If a real run consistently produces zero or one child regardless of task
  size, that would be evidence the guidance in `TASK.md` needs to nudge
  harder toward decomposition (the one open decision noted in
  `plans/alineo-rlm-substrate.md` — deliberately left for exactly this kind of
  observation).

## Debugging history: every real bug found getting this to run live

**Naming note**: the CLI command for forking a running session's own live
sandbox was called `alineo spawn` at the time everything below happened. It
was later renamed to `alineo fork` (`alineo spawn` now means "start a fresh
agent," the old meaning of `alineo run`) — see the `feat/sandbox-id-addressing`
branch. The entries below keep the name that existed at the time, for
historical accuracy; read `alineo spawn` below as what's now `alineo fork`.

Getting a live run of this example working surfaced a chain of real, distinct
bugs — worth recording in full since several looked like something else
entirely until isolated:

1. **Wrong model ID.** The spec originally used
   `nvidia/nemotron-3-super-120b-a12b:free` — an OpenRouter-style suffix that
   doesn't exist on NVIDIA's own native API. Found via `pi --list-models
nvidia` and a working local `pi -p` call with the correct ID (no `:free`).
2. **Stale published `alineo-cli`.** The setup step's `npm install -g alineo-cli`
   always installs whatever's currently on npm — it silently ran against
   `alineo-cli@0.5.0` (pre-`spawn`) until the `chore: version packages` PR merged
   and `0.6.0` published. (`examples/rlm-repo-fanout/index.ts` has a
   `REBUILD=1` escape hatch to force past a stale cached snapshot after any
   future `alineo-cli` release.)
3. **A genuine OpenSandbox proxy bug.** Confirmed via DeepWiki against
   `opensandbox-group/OpenSandbox`: the generic `/sandboxes/{id}/proxy/{port}`
   endpoint (what `sb.proxy()` routes through) proxies via an `httpx` client
   with no configured read timeout, which falls back to httpx's 5s default.
   Any gap that long between bytes written to the bridge's SSE response
   (model thinking time, a slow tool call) got the proxy's connection to the
   bridge killed — a `500`, or a stream that silently ended early. Fixed in
   `packages/agent/src/adapters/pi.ts`: the bridge now writes a `: ping` SSE
   comment (spec-legal, ignored by clients) every 3s while a `/prompt` or
   `/bash` call is in flight, keeping that idle timer from ever firing.
4. **The bridge silently dropped a failed prompt.** Even with the heartbeat
   fix, a run could still hang forever: if Pi rejected a prompt outright
   (`{"success":false,"error":"..."}`), that ack isn't tracked the way
   `/bash` results are, so the bridge just... didn't forward it. The client
   sat behind the heartbeat indefinitely instead of seeing a clean error.
   Fixed in the same file: a rejected prompt now ends the SSE stream with the
   real error immediately.
5. **What #4 was actually masking.** Once errors surfaced instead of hanging,
   Pi reported `"No API key found for nvidia"` — even though the key was
   right there in `.env`. Root cause: Bun only loads `.env` from the shell's
   CWD at invocation, it does not walk up to the repo root — running this
   example from inside `examples/rlm-repo-fanout` (which has no `.env` of
   its own) silently resolved `NVIDIA_API_KEY` to an empty string. The
   example builds a sandbox fine either way; only the _live model call_
   fails. `index.ts` now checks `NVIDIA_API_KEY` up front and refuses with a
   clear message instead of building a doomed sandbox.
6. **Missing `bun` runtime.** `alineo`'s own npm package ships with a
   `#!/usr/bin/env bun` shebang — the `node:22` base image has no `bun` at
   all, so `alineo` couldn't run regardless of everything else being correct.
   `master.json`'s setup now installs bun and symlinks it onto `/usr/local/bin`
   (already on `$PATH` by default), rather than relying on a per-exec-session
   `PATH` export that wouldn't persist anyway.
7. **`openai/gpt-oss-20b` mangles tool names via NVIDIA.** Fastest in
   single-call benchmarks, but leaks its own "harmony" chat-template channel
   tokens into tool names (`bash<|channel|>commentary`) on roughly half its
   calls when served through NVIDIA — every one of those fails before the
   tool even runs.
8. **A structural Pi+NVIDIA tool-calling issue, found across three separate
   models, not fixed.** After #1–7, `index.ts` was updated to log a failed
   tool call's actual result content (not just `isError`), which is what
   surfaced this clearly instead of leaving it as an unexplained hang. Three
   different models, driven the same way through Pi's `openai-completions`
   API path against NVIDIA, each corrupted tool calls in a _different_
   shape:
   - `openai/gpt-oss-20b` — its harmony-format channel tokens leak into the
     tool _name_ (item 7, above).
   - `nvidia/nemotron-3-nano-30b-a3b` — occasionally emits a raw
     `<function=bash><parameter=command>...` XML-ish string as plain text
     instead of a real tool call.
   - `nvidia/nemotron-3-super-120b-a12b` — its own reasoning text and a
     _second_, nested tool-call attempt bled into the _first_ call's command
     argument (`"ls.\n\nWe need to use alineo spawn command...<tool_call>\n
<function=bash>\n<parameter=command>\nls -la"`), producing an
     unparseable shell string and a `127` exit — the master's turn ended
     right after, without retrying.

   Three models, three different corruption shapes, through one integration
   path — that pointed at Pi's streaming tool-call parser for NVIDIA's API
   specifically, not any one model's competence. Trying more NVIDIA models
   (below) eventually did find one with zero corruption of this kind, so
   this turned out not to require an upstream fix or a provider switch — but
   it took two more models (`meta/llama-3.1-8b-instruct`,
   `nvidia/nvidia-nemotron-nano-9b-v2`) to find one.

9. **`meta/llama-3.1-8b-instruct` sends a malformed `timeout` argument.**
   Clean tool _names_, but its bash tool calls set `"timeout":"null"` (the
   literal string `"null"`, not a number or an omitted field), which fails
   Pi's schema validation on nearly every call. Also fired 5–6 tool calls in
   one turn without waiting for results in between, causing order-dependent
   races (a `wc -l` on a file its own preceding `write` call hadn't actually
   finished yet). Ruled out.
10. **`nvidia/nvidia-nemotron-nano-9b-v2` had zero structural tool-call
    corruption** across every multi-turn stress test, including
    self-correcting a real mistake via the `edit` tool unprompted (see "Why
    this model"). Switched the master to this model.
11. **Missing `mkdir -p .alineo` before writing `alineo.config.json`.** With a
    clean model finally reaching a real `alineo spawn` call, the next failure
    was `Error: unable to open database file` — `alineo`'s own `init`/
    `writeConfig` always creates the `.alineo` directory before writing the
    config that points `adapterPath` at `.alineo/ledger.db`, but this
    example's setup step hand-writes `alineo.config.json` via `printf` and
    skipped that step, so `SQLiteAdapter` had nowhere to create the file.
    Fixed by adding `mkdir -p .alineo` to the same setup step.
12. **`alineo spawn`'s session lookup can never find its own caller when the
    caller wasn't started via `alineo run`.** With the database fixed,
    `alineo spawn` still failed: `No running session named
'rlm-fanout-master'`. Root cause: `alineo spawn <name> ...` looks its own
    session up by name in the local ledger to get a sandbox ID — but the
    master here was created via `Agent.load()` from a _host_ process, using
    a _host-side_ `SQLiteAdapter('./ledger.db')`. That `sandbox_created`
    event lives only in that host file. `alineo spawn`, running _inside_ the
    sandbox, opens a _different_, freshly-created `SQLiteAdapter` pointed at
    `.alineo/ledger.db` _inside the container_ — an empty file that has never
    heard of a sandbox named `rlm-fanout-master`, because the two ledgers
    are different files on different filesystems that were never going to
    see each other. Fixed by having every agent-creation path
    (`Agent.load()`, `Agent.resume()`, `Agent.spawn()`) write a
    `ALINEO_SANDBOX_ID` env var to `/etc/alineo-env`, and having `alineo spawn`
    resolve its own sandbox ID from that env var first, falling back to the
    old ledger lookup only if it's unset (`packages/agent/src/agent.ts`,
    `packages/cli/src/commands/spawn.ts`).
13. **`Agent.attach()`'s own self-connect broke immediately after #12's
    fix.** Once self-identification worked, the very next call —
    `Agent.attach()` reading `/etc/alineo-env` via a network exec call to
    resolve its _own_ sandbox's endpoint — failed with "Unable to connect.
    Is the computer able to access the url?". Fixed by reading the file from
    the local filesystem directly when the target sandbox ID matches this
    process's own `ALINEO_SANDBOX_ID` (`packages/agent/src/agent.ts`), since a
    process attaching to _itself_ already has the file on disk and never
    needed the network round-trip. (Bisected via targeted diagnostic
    `console.error` calls at each step of `Agent.attach()`/`alineo spawn`,
    surgically patching the two changed compiled files inside an
    already-`npm install -g`'d `alineo` — the fix wasn't published to npm
    yet, so the real installed package needed the new code grafted in to
    test it before a release.)
14. **A red herring turned up during #13's diagnosis: an unset
    `MASTER_AGENT_OPENSANDBOX_DOMAIN` produced the exact same "Unable to
    connect" error, but it was an artifact of the throwaway diagnostic
    script used to test #12/#13 before they were published, not a bug in
    the committed `index.ts`.** With `console.error` markers bisecting
    `Agent.attach()`, `readProjectConfig()`'s return value showed
    `serverUrl: "http://"` (`resolveEnv()` silently interpolates an unset
    `${VAR}` to an empty string, not an error). The diagnostic script had
    copied `index.ts`'s flow by hand but omitted the line `index.ts` already
    has: `process.env.MASTER_AGENT_OPENSANDBOX_DOMAIN ??= "172.17.0.1:8080"`
    (line 49) — a default the real example has carried since before this
    session. Worth recording because it cost real time chasing (and briefly,
    incorrectly, ruling out two Docker-networking theories — self-referential
    bridge-IP hairpinning and `useServerProxy` routing — before realizing the
    var was simply unset in the _script_, not missing from the _example_).
    `.env` now also documents `MASTER_AGENT_OPENSANDBOX_DOMAIN` explicitly
    (harmless, and useful for anyone writing their own script against this
    pattern without `index.ts`'s built-in default), but it wasn't the actual
    fix for the committed example — #12 and #13 were.

With #1–14 fixed and patched in locally, a live run got `alineo spawn`
returning a clean success (`isError=false`) for the first time in the entire
investigation — the master correctly reading `TASK.md`, spawning a real
child via the exact documented syntax, with no tool-call corruption, no
database error, no self-lookup failure, and no connection error. The one
remaining source of run-to-run flakiness is ordinary model noise unrelated
to any of the above (e.g. typing `trejx` instead of `alineo`), not a
structural issue.

**Important caveat for anyone re-running this example today**: fixes #12 and
#13 live in `packages/agent` and `packages/cli` source, not yet in a
published npm release — `master.json`'s setup step still does
`npm install -g alineo-cli`, which pulls the last published version without
these fixes. A live run of the _committed_ example will still fail at the
`alineo spawn` step until a new `alineo`/`@alineo-labs/agent` version is published
via the normal changeset flow (see `.changeset/spawn-self-attach-fix.md`).
The confirmation above was done by installing the published package as
normal, then surgically overwriting the two changed compiled files with
local builds before prompting — a valid way to verify the fix live, but not
what a fresh `npm install -g alineo-cli` gets you until that release ships.
`Agent.spawn()`'s own mechanism (fork, env-leak fix, depth injection,
depth-zero refusal) remains independently, thoroughly verified via `.bash()`
and direct SDK calls, unaffected by any of #8–14 above since none of those
touch the fork/depth/env-scoping logic itself.

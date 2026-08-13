# rlm-master

A reusable RLM orchestrator master — unlike `examples/rlm-repo-fanout`, this
isn't tied to any one task. It's meant to be started from a real, interactive
Pi session (hop 1 of the two-hop flow in
`plans/pi-extension-rlm-flow.md`), not a hand-written script, and given
whatever goal you actually want done.

## Setup

Install the alineo Pi extension on your host machine once:

```bash
pi install npm:alineo
```

This installs at **user** scope (`~/.pi/agent/extensions`), so it's
available in every Pi session afterward — the extension itself bootstraps
`alineo` (installs it, runs `alineo init`) the first time a session starts, so
there's no separate manual setup step.

Needs `NVIDIA_API_KEY` in your environment (or whichever provider your own
copy of `agents/master.json` is configured for).

## Run

From your own Pi session:

```
> use alineo to spawn ./examples/rlm-master/agents/master.json and give it this goal: <your actual goal>
```

Pi already knows the `alineo spawn` syntax (injected by the extension — see
`SPAWN_ONLY_GUIDANCE` in `packages/cli/pi-extension/alineo.ts`), so this
doesn't need to be a literal command; describing the goal is enough for a
model to write the right `alineo spawn ./examples/rlm-master/agents/master.json
--prompt "<goal>" --json` call itself.

The master's own sandbox also has the extension installed (baked in by a
setup step), so once it's running, it has `alineo fork` guidance injected the
same way — see `FORK_GUIDANCE` in the same file. It decides for itself
whether the goal is worth decomposing; nothing forces it to fork anything.

## Customizing the master's mindset

The master's system prompt gets an RLM-orchestrator mindset appended
automatically (`ALINEO_RLM_MASTER: "1"` in its `env` — see
`DEFAULT_RLM_MINDSET` in the extension). To use your own wording instead, set
`ALINEO_RLM_SYSTEM_PROMPT` before spawning:

```bash
export ALINEO_RLM_SYSTEM_PROMPT="Your own custom orchestrator instructions..."
```

## What's still a placeholder

- **Context gathering isn't wired up yet.** Per `plans/pi-extension-rlm-flow.md`'s
  open questions, dynamically injecting "spawn an explorer first" guidance
  based on a user-supplied hint (rather than the master figuring it out
  entirely on its own) hasn't been built.
- **`--max`'s ceiling is per-lineage only** (this master sets `"maxAgents": 10`
  as a starting default) — not coordinated across sibling branches spawned
  in parallel. See the plan's open question 3.
- **Live-verify before trusting this for anything real.** This has not yet
  had the same live-run debugging pass `examples/rlm-repo-fanout` went
  through — treat it as a first cut, not a proven path.

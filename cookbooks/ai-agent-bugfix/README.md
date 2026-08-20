# ai-agent-bugfix

An AI agent that debugs a failing test and fixes the bug itself — inside its own sandbox, using
nothing but bash and a model.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
export NVIDIA_API_KEY=...   # https://build.nvidia.com — free tier available
```

## Run

```bash
bun install
bun start
```

## What it does

1. Plants a deliberate off-by-one bug in `calc.py` and a test that catches it
2. Runs `pytest` via `agent.bash()` to show the failure
3. Prompts the agent — via `@alineo-labs/agent`'s `Agent.load()` + `agent.prompt()` — to find and
   fix the bug itself, streaming its reasoning and tool calls as they happen
4. Re-runs `pytest` independently of the agent (via `agent.sandbox.exec()`) to verify the fix,
   rather than trusting the agent's own claim that it passed

`agents/bugfix-agent.json` configures a Pi agent on `python:3.11-slim` using the NVIDIA NIM API.
Swap `provider`/`model` for anything in `@alineo-labs/model-providers` to use a different key.

## Notes

Step 3's independent verification is the important part of this recipe: never trust an agent's
self-report that a fix worked — re-run the check yourself against the sandbox it was working in.

See the [Agent SDK docs](/docs/agent) for the full `@alineo-labs/agent` API (`prompt`, `bash`,
`steer`, `fork`, model switching, and more), and
[examples/pi-agent](https://github.com/DrejT/alineo/tree/main/examples/pi-agent) for a tour of
every command it exposes.

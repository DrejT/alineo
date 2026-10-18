# alineod-provider

Check that alineod runs agents on the configured sandbox provider and says which one, in the agent view and the run tree.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
ALINEOD_URL=http://localhost:4600 bun start
```

## What it does

Creates a run, waits for the root agent's sandbox, and prints `provider` from `GET /agents/:id` and `GET /runs/:id`. It never prompts the agent, so it uses no model quota. Needs a running alineod with `NVIDIA_API_KEY` in its environment.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

# durable-agent

An agent's container is removed. The agent comes back from its last turn checkpoint, with the
same Pi session and the same files.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
export NVIDIA_API_KEY=...
```

If your account no longer serves the default model, set `NVIDIA_MODEL` to one it does serve.

## Run

```bash
bun install
bun start
```

## What it does

1. Starts a Pi agent and runs a turn that writes `/root/work/note.txt`.
2. Calls `takeCheckpoint()`. This tars `/root` (Pi's session file) and `/workspace` to disk.
3. Removes the container with `docker rm -f`.
4. Calls `Alineo.resume()`. It finds the sandbox gone, provisions a fresh one from the cached
   setup snapshot, and restores the checkpoint. `agent.restore` is `{ checkpointTurn: 1 }`.
5. Shows that the Pi `sessionId` is unchanged and that the agent can read the file.

## With alineod

alineod does steps 2 and 4 for you. Set `"checkpoint": true` in the agent spec and alineod
checkpoints after every turn that finishes cleanly. After the container is lost, restart alineod:
it restores the agent at boot and records `agent.restored` with the turn it restored from.

## What a checkpoint covers

- **Covered:** everything under `/root` except package caches (`.npm`, `.cache`, and similar), and
  `/workspace` when it exists, except its `node_modules` directories. Install those again after a restore.
- **Not covered:** files anywhere else, and a turn that was still running when the container
  was lost. Side effects of that turn may happen again if it is retried.
- **Where it lives:** a file on the host that runs the agent. Losing that disk loses the
  checkpoint.
- **No checkpoint:** the agent comes back with a blank session, and `agent.restore` is
  `{ checkpointTurn: null }`.

The integration tests `tests/integration/checkpoint-restore.test.ts` and
`tests/integration/alineod-container-loss.test.ts` run these steps and assert the result.

# snapshot-replay

Demonstrates alineo's checkpoint and resume feature: run once to install dependencies and capture a snapshot, then resume from that snapshot — skipping the install — to run updated code against the same environment.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it does

**Initial run**

1. Creates a Python 3.11 sandbox
2. Installs `requests` via pip
3. Captures a checkpoint (`after-install`)
4. Runs a script and closes the sandbox

**Resumed run**

1. Calls `client.resume(sandboxId)` — boots from the snapshot
2. The `pip install` call returns cached output instantly (never re-runs)
3. Runs an updated script on the restored container

Run `bun start` twice to see the difference: first run takes ~30–60s; the resume takes ~2–3s.

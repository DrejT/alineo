# environments

Demonstrates sandbox environments: build a reusable sandbox image once, then restore from the snapshot on every subsequent run — skipping the setup entirely.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start        # ~30–60s first run (builds environment)
bun start        # ~2–3s on subsequent runs (restores from snapshot)
```

## What it does

**First run** — environment not yet cached:

1. Installs Python 3 and pip into a `debian:bookworm-slim` container
2. Installs `numpy` and `pandas` via pip
3. Snapshots the container and saves the snapshot ID to the ledger

**Subsequent runs** — environment cached:

1. Finds the existing snapshot in the ledger
2. Boots directly from the snapshot — no apt-get or pip install
3. Runs `import numpy, pandas` to prove packages are already present

The ledger entry is keyed by the environment name (`"python-data-science"`), so the snapshot is reused across process restarts.

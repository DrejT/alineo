# sandbox-fork

Demonstrates `sb.fork()`: install dependencies once into a base sandbox, then branch into two independent sandboxes that run different workloads in parallel — without repeating the install.

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

1. Creates a `python:3.11-slim` sandbox and installs `numpy`
2. Forks into two independent sandboxes (`track-a`, `track-b`) from the post-install state
3. Runs a different numpy computation on each fork in parallel
4. Lists the checkpoints recorded on the original sandbox
5. Closes all three sandboxes

Both forks start with numpy already installed — neither pays the pip install cost again.

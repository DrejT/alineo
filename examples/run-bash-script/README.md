# run-bash-script

Run a multi-line bash script inside an isolated sandbox and stream its output.

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

1. Creates an Ubuntu 22.04 sandbox
2. Runs a bash script that prints system info, disk usage, and writes/reads a file
3. Streams output to stdout as it arrives
4. Deletes the sandbox on completion

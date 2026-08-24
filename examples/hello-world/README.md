# hello-world

The simplest alineo example: spin up an Ubuntu sandbox, run `echo "hello world"`, and stream the output.

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
2. Executes `echo "hello world"` inside it
3. Streams output to stdout
4. Deletes the sandbox on completion

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable (e.g. when using `uvx opensandbox-server` on the host).

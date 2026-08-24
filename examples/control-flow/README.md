# control-flow

Demonstrates all of alineo's built-in workflow control-flow primitives in a single sandbox.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it shows

| Primitive | Description                                                    |
| --------- | -------------------------------------------------------------- |
| `retry`   | Retries a flaky command up to 5 times with exponential backoff |
| `when`    | Branches conditionally based on the previous exec's exit code  |
| `forEach` | Iterates over a list, running a command per item               |

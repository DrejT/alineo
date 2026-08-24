# error-handling

Demonstrates the two error-handling modes for exec commands, and the error types you may encounter.

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

| Pattern               | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| Non-strict exec       | `exec("...", { strict: false })` returns the result; you inspect `exitCode` yourself |
| Strict exec (default) | Non-zero exit throws `CommandError` — catch it to handle the failure                 |
| Error types           | `CommandError`, `SandboxError`, `ExecConnectionError` — when each is thrown          |

Two sandboxes run sequentially, one per pattern.

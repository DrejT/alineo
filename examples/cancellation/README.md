# cancellation

Demonstrates resource cleanup and error handling patterns when commands fail or time out.

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

| Pattern        | Description                                           |
| -------------- | ----------------------------------------------------- |
| `try/finally`  | Guarantees `sb.close()` runs even when an exec throws |
| Bash `timeout` | Limits a command's wall-clock time at the shell level |
| `CommandError` | Catching the error thrown by a non-zero exit code     |

Three sandboxes run sequentially, each demonstrating one pattern.

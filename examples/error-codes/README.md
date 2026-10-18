# error-codes

Branch on a stable error `code` instead of message text, and read the `hint` that says what to do next.

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

Triggers a failed command, a missing sandbox and an image that cannot be pulled. For each it prints `errorCodeOf()`, `isRetryable()`, the message and the hint.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

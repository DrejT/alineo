# exec-result

Read how a command ended: `durationMs`, `killed`, `signal`, `timedOut`, an `AbortSignal` that interrupts it, and the command size limit.

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

Runs a 1 s command, one stopped by `timeoutMs`, one that kills itself, one aborted by an `AbortSignal`, and a command over 92 KB, which is refused with `INVALID_ARGUMENT` before it is sent. `timedOut` is inferred from elapsed time, so use it to explain a failure and not to decide a retry.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

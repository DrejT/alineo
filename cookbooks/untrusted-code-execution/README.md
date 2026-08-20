# untrusted-code-execution

Safely execute untrusted or LLM-generated Python snippets — each one gets its own throwaway,
resource-capped sandbox with a wall-clock timeout, and failures are captured as data instead of
crashing the batch.

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

Runs three Python snippets in parallel, each in its own sandbox:

1. `well-behaved` — a snippet that just prints a value
2. `raises` — a snippet that raises an uncaught exception
3. `infinite-loop` — a snippet that never terminates on its own

Each sandbox is created with tight `resources` (`250m` CPU / `128Mi` memory), a 30s container
`timeout`, and a 5s `timeoutMs` on the exec call itself. `strict: false` means a non-zero exit is
returned as data (`exitCode`, `stdout`, `stderr`) instead of throwing, so one bad snippet doesn't
abort the batch. Every sandbox is closed in `finally`, even on timeout or crash.

## Notes

Reach for this pattern any time you're executing code you didn't write yourself — an LLM's
generated code, a user-submitted script, a plugin. Swap `runUntrusted()`'s body for
`execCode()`/`createCodeContext()` (see [Code Interpreter](/docs/examples/exec-code)) if you want a
stateful REPL instead of one-shot scripts.

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

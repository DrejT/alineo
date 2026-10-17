---
"@alineo-labs/core": minor
"@alineo-labs/opensandbox": patch
"@alineo-labs/schema": patch
---

Say how a command ended, and let a caller abort it.

- `ExecResult` gains optional `durationMs`, `killed`, `signal`, and `timedOut`. A command that a
  signal ended is `killed` with the `signal` execd reported. It is `timedOut` when it was killed
  after running for `timeoutMs`. A timeout and a kill from inside look the same on the wire, so
  `timedOut` is a best guess from the elapsed time: a kill that lands close to the limit reads as a timeout. A command that exits non-zero on its own is none
  of these.
- `ExecOptions.signal`: an `AbortSignal`. On abort the call rejects with the signal's reason
  (`AbortError` by default) and execd is asked to interrupt the command, best effort. A signal that
  is already aborted rejects before anything is sent.
- `exec.completed` records `durationMs`, `killed`, `signal`, and `timedOut` when they apply.
  A row for an ordinary command is unchanged.
- `SSEEvent.error` types `ename` and `traceback`, which execd was already sending.

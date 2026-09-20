# @alineo-labs/logger

## 0.1.0

### Minor Changes

- 7f0d5c2: New `@alineo-labs/logger`: a dependency-free logger that is **silent by default**, with one switch to turn it on and child loggers for context (`getLogger("agent").child({ runId, agentId })`).

  **Behavior change — `alineo` (the agent SDK) no longer prints to stdout.** `Alineo.load()` / `.resume()` / `.reattach()` / `.spawn()` used to `console.log` progress lines (`[agent] starting sandbox…`, `[agent] bridge ready 3210ms`, …) unconditionally, with no way to silence them. They now go through the logger as component `agent`, which emits nothing until logging is on. To see them again, set `ALINEO_LOG_LEVEL=info` (no code change needed) or call `installLoggerFromEnv({ defaultLevel: "info" })` / `installLogger()` at your app's entrypoint. Output goes to **stderr** — pretty on a terminal, JSON lines otherwise (`ALINEO_LOG_FORMAT=pretty|json` overrides); `ALINEO_LOG=agent=debug,alineod=info` sets per-component levels and `ALINEO_LOG_FILE` writes to a file instead.

  Each of those lines now carries the agent's spec `name` (and the `runId` when the caller supplied one, as alineod does), so output from several agents loading at once is attributable. Best-effort cleanups that fail — most importantly closing a sandbox after a failed load, which can leak it — now log a `warn` instead of being swallowed, and an `onPermission` handler that throws is logged instead of vanishing.

  `alineo-cli` turns logging on at `info` for its subcommands, so `alineo spawn`, `alineo prompt`, … still show progress — now on stderr rather than stdout, which also keeps `--json` output on stdout free of progress lines. `ALINEO_LOG_LEVEL=warn` (or `silent`) quiets it. The interactive TUI is unaffected.

  `@alineo-labs/core`: `ILogger`, `LogLevel`, `ConsoleLogger` and `noopLogger` moved to `@alineo-labs/logger`. `@alineo-labs/core` keeps re-exporting them unchanged, so existing imports still work; prefer importing from `@alineo-labs/logger`.

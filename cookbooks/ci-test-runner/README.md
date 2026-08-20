# ci-test-runner

Run a repo's test suite in a disposable, CI-style sandbox and turn the raw output into a
structured pass/fail report — the building block for a PR check, a bot, or an agent that needs to
know "did the tests pass" without scraping a log.

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

1. Scaffolds a tiny Python project (`calc.py` + `test_calc.py`) directly in the sandbox — one test
   deliberately fails, so you see a real failure report
2. Installs `pytest`
3. Runs the suite with `strict: false` so a non-zero exit is data, not a thrown error
4. Prints a structured report (`status`, `summary`, and the full output on failure) and sets
   `process.exitCode` accordingly — the same shape a CI step or bot would check

## Notes

Swap the "scaffold a project" step for a real clone to point this at any repository:

```ts
await sb.exec(`git clone --depth 1 ${repoUrl} /workspace`);
```

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

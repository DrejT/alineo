# parallel-test-shards

Install dependencies once, then fork the sandbox into N independent copies that each run a shard
of the test suite in parallel — cutting wall-clock time roughly by the number of shards, without
repeating the install in every shard.

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

1. Creates one base sandbox, installs `pytest`, and writes three small test files to it
2. Calls `base.fork()` three times — each fork branches off the base sandbox's state, so none of
   them repeat the `pip install`
3. Runs a different test file in each fork with `Promise.all`, in parallel
4. Aggregates each shard's exit code and a one-line summary into an overall pass/fail report

## Notes

This generalizes directly to a real repo: install dependencies and discover shard boundaries once
in the base sandbox, then fork once per shard (or per CPU core) instead of paying setup cost N
times. See [Forking Sandboxes](/docs/examples/sandbox-fork) for the underlying `sb.fork()` primitive.

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

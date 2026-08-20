# resumable-etl-pipeline

A multi-stage ETL pipeline (extract → transform → load) that checkpoints after each stage, so a
crash — or just wanting to re-run "load" in isolation — doesn't mean paying for extract and
transform again.

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

**Original run:**

1. **Extract** — installs `pandas`, writes raw CSV data, then `sb.checkpoint("after-extract")`
2. **Transform** — aggregates revenue by region with pandas, writes `transformed.csv`, then
   `sb.checkpoint("after-transform")`
3. **Load** — reads back the final output and "publishes" it (prints it)

**Resumed run** — simulates picking the pipeline back up later:

1. `client.resume(sandboxId)` restores the container from the last checkpoint (`after-transform`)
2. Re-issuing the exact `pip install` command from the extract stage replays instantly from the
   ledger — no network call, no re-install
3. `transformed.csv` is already present on the restored container's filesystem, so the load stage
   reads it straight away — the transform never re-runs

## Notes

Every `sb.checkpoint(tag)` is a real container snapshot, not just a ledger bookmark — the restored
container genuinely has extract and transform's output on disk. The ledger replay on top of that is
an optimization: an exec that exactly matches one already recorded before the checkpoint returns
its cached result instead of re-running. See [Checkpoint & Resume](/docs/examples/snapshot-replay)
for the primitive this recipe builds on.

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

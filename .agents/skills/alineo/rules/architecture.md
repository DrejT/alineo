# Architecture at a Glance

```
Alineo (SDK client)
  ├── ControlClient (@alineo-labs/opensandbox)   — REST: create/stop/snapshot sandboxes
  ├── ExecClient (@alineo-labs/opensandbox)       — SSE: stream exec output
  ├── IStorageAdapter                             — pluggable durable ledger
  │     ├── SQLiteAdapter (@alineo-labs/sqlite)   — local dev / scripts
  │     └── PostgresAdapter (@alineo-labs/postgres) — production
  └── Sandbox / BashSession (@alineo-labs/core)   — the live handle you hold
```

Each sandbox exec is recorded in the ledger as:
`exec_start` → `exec_event`s (stdout/stderr chunks) → `exec_complete`

`sb.checkpoint()` writes `checkpoint_created`.
`client.resume(sandboxId)` restores from the snapshot and replays cached exec
results up to the checkpoint — execs after it run live.

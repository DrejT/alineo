# Architecture at a Glance

```
alineo-cli (spawn/prompt/fork/agents/kill/logs)
  └── Alineo (agent SDK, `alineo` package)
        ├── PiAdapter                — installs Pi CLI in the sandbox, bridges Pi RPC over HTTP/SSE
        ├── AgentSnapshotStore       — caches installed-CLI snapshots, keyed by setup hash
        ├── IStorageAdapter          — pluggable durable ledger, same interface the sandbox uses
        │     ├── SQLiteAdapter (@alineo-labs/sqlite)   — local dev / scripts
        │     └── PostgresAdapter (@alineo-labs/postgres) — production
        └── SandboxHandle            — the underlying live container (`agent.sandbox`), from
                                        @alineo-labs/sandbox — exec/file ops available directly
```

`Alineo` wraps a sandbox container: it installs the Pi CLI, snapshots the result, and bridges
Pi's RPC protocol so `agent.prompt()`/`agent.bash()` stream back as `AgentEvent`s. It does not
reimplement sandbox lifecycle — `agent.sandbox` is a real `SandboxHandle` for direct
exec/file access when you need to bypass Pi.

Each agent action is recorded in the ledger the same way sandbox execs are:
`exec_start` → `exec_event`s (stdout/stderr chunks) → `exec_complete`.

`Alineo.load()` installs the CLI + setup steps once, then checkpoints — subsequent loads restore
from that snapshot (`agent.fromSnapshot`). `Alineo.resume(sandboxId)` reconnects a bridge to an
existing container after the host process exits; `Alineo.attach(sandboxId)` connects without
touching the bridge at all, for `.spawn()`-only access.

## Where alineod fits

**alineod is not part of this diagram** — it's a separate HTTP+SSE process (own Docker image,
`ghcr.io/drejt/alineod`) that calls this same `Alineo` class server-side, in-process, from inside
its own request handlers, to orchestrate many agents as one swarm (spawn tree, budgets, `waitFor`
gather, steer/pause/resume). None of the CLI commands above talk to it — `alineo spawn`/`fork`/
`prompt`/`steer` always call `Alineo` directly, whether or not alineod happens to be running. See
[CLI Reference § alineod](cli.md#alineod-the-swarm-daemon) for how it's launched, and
`apps/alineod/README.md` for its own architecture (ledger/agents/handles tables, crash-only
rehydrate).

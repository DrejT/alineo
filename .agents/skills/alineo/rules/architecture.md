# Architecture at a Glance

```
alineo-cli (init/start/prompt/spawn/steer/agents/stop/logs/add/list/remove)
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
`exec.started` → `exec.output`s (stdout/stderr chunks) → `exec.completed`.

### One vocabulary

CLI, SDK, alineod's HTTP API, the MCP tools and the event stream share one set of words
(`SUBJECTS` / `VERBS` in `@alineo-labs/schema`), and `bun run check:vocabulary` enforces it in CI:

- **CLI** `alineo <verb> [args]` · **SDK** method = the verb, class = the subject
- **HTTP** `/{subjects}/:id/{verb}` · **MCP tool** `{subject}_{verb}` · **Event** `{subject}.{past-tense verb}`

Event names are namespaced by **subject**, not emitting layer: `agent.spawned`, `exec.started`,
`sandbox.checkpoint_created`, `permission.requested`. The old flat names (`exec_start`,
`checkpoint_created`, ...) survive only in `packages/schema/src/renames.ts`, for the one-time
store migration. Never write one in new code or docs.

Retired commands (**alineo fork**, **alineo kill**, and the old **alineo spawn** that meant "create
a root agent" — now `start`) must never appear in a code span: a skimming reader or model would
run them. Name them in bold prose when a history note is needed.

### Package map (where to look)

| Package                                                                                    | Role                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `alineo` (`packages/agent`)                                                                | Agent SDK — the `Alineo` class                                                 |
| `alineo-cli` (`packages/cli`)                                                              | The `alineo` binary                                                            |
| `alineo-mcp` (`packages/mcp`)                                                              | MCP server over alineod's HTTP+SSE API                                         |
| `@alineo-labs/schema`                                                                      | Types + Zod only: vocabulary, `AgentSpec`, event definitions, `LedgerEnvelope` |
| `@alineo-labs/ledger`                                                                      | Behaviour: `EventSink`, `LedgerStorage`, fold/replay helpers                   |
| `@alineo-labs/memory` (+ `sqlite-memory`, `postgres-memory`)                               | Working + semantic memory, episodic recall                                     |
| `@alineo-labs/sandbox`, `@alineo-labs/workflow`, `@alineo-labs/otel`, `@alineo-labs/vault` | Not covered by this skill                                                      |
| `apps/alineod`                                                                             | The swarm daemon (Bun + Elysia + `bun:sqlite`)                                 |

`Alineo.start()` installs the harness + setup steps once, then snapshots — subsequent starts
restore from that **setup snapshot** (`agent.fromSnapshot`). Three ways back to a live agent:

- `Alineo.reattach(sandboxId)` — try first. Keeps the bridge if it is alive.
- `Alineo.resume(sandboxId)` — the bridge really is gone: restarts it. With a spec that sets
  `checkpoint: true` it can also rebuild from the last **turn checkpoint** when the container
  itself is gone.
- `Alineo.attach(sandboxId)` — connect without touching the bridge at all, for `.spawn()`-only
  access.

Three things get called "snapshot"/"checkpoint" and only one carries a conversation — see
[alineod § durability](alineod.md#the-durability-contract).

## Where alineod fits

**alineod is not part of this diagram** — it's a separate HTTP+SSE process (own Docker image,
`ghcr.io/drejt/alineod`) that calls this same `Alineo` class server-side, in-process, from inside
its own request handlers, to orchestrate many agents as one swarm (spawn tree, budgets, `waitFor`
gather, steer/pause/resume). None of the CLI commands above talk to it — `alineo start`/`spawn`/
`prompt`/`steer` always call `Alineo` directly, whether or not alineod happens to be running. See
[alineod](alineod.md) for what it does, [CLI Reference § alineod](cli.md#alineod-the-swarm-daemon)
for how it's launched, and `apps/alineod/README.md` for its own architecture (a `ledger` table as
source of truth, `agents`/`handles` as caches rebuilt from it — crash-only).

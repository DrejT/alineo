---
name: alineo
description: >-
  Use when working with the alineo SDK, running or writing sandbox code, working
  with the alineo CLI (init/spawn/prompt/fork), writing or debugging storage
  adapters (SQLite/Postgres), authoring examples or integration tests, or
  diagnosing issues with the OpenSandbox server. Covers the full local dev
  workflow: server startup, sandbox lifecycle, exec, checkpoint/resume,
  environments, ledger querying, and Windows-specific gotchas.
metadata:
  version: "1.0"
---

# Alineo Skill Reference

## Product Summary

`alineo` is a **sandbox execution substrate** built on [OpenSandbox](https://opensandbox.ai).
It gives you live Linux containers as first-class objects — spawn, exec, checkpoint, resume —
with a durable SQL audit ledger and replay. The TypeScript SDK is the primary interface;
a CLI (`alineo-cli`) wraps common operations for local dev.

---

## Architecture at a Glance

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

---

## Quick-Start Workflow

### 1 — Start the local server (Docker required)

```bash
# Recommended: CLI manages Docker for you
bunx alineo-cli init

# Alternative: manual uvx
uvx opensandbox-server
```

`alineo init` writes `alineo.config.json` in the current dir and a server config
at `~/.config/alineo/server.toml`. When the server runs in Docker you **must**
pass `useServerProxy: true` to `new Alineo(...)`.

> **Windows gotcha:** `alineo init` mounts the Docker socket as
> `/var/run/docker.sock` (the Unix path) because Docker Desktop on Windows
> transparently proxies this path into its Linux VM. The Windows named pipe
> (`//./pipe/docker_engine`) **cannot** be used here — the OpenSandbox server
> is a Linux Python process that only knows the Unix socket path.

### 2 — Write a script

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./.alineo/ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false", // must be true with alineo init
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" }, // REQUIRED — server rejects without this
  name: "my-run",                              // ledger key; auto-generated if omitted
});

try {
  const { stdout, exitCode } = await sb.exec("echo hello");
  await sb.exec("npm test").pipe(process.stdout); // stream to terminal
  await sb.checkpoint();                          // snapshot the container
} finally {
  await sb.close(); // always in finally — releases slot and writes sandbox_closed
}
```

### 3 — Run it

```bash
bun examples/hello-world/index.ts
```

---

## Key API Reference

### `new Alineo(opts: AlineoOptions)`

| Option | Type | Notes |
|---|---|---|
| `baseUrl` | `string` | `http://127.0.0.1:8080` for local dev |
| `apiKey` | `string?` | Empty string for local dev (no auth) |
| `adapter` | `IStorageAdapter` | Pass `new SQLiteAdapter(path)` |
| `useServerProxy` | `boolean?` | **Must be `true`** when server started via `alineo init` |
| `maxConcurrency` | `number?` | Cap simultaneous active sandboxes; `sandbox()` awaits a slot |

### `client.sandbox(opts: SandboxOptions): Promise<Sandbox>`

| Option | Required | Notes |
|---|---|---|
| `image` | ✅ | `"ubuntu:22.04"` or `{ uri, auth? }` |
| `resources` | ✅ | `{ cpu: "500m", memory: "256Mi" }` — server rejects without it |
| `name` | ❌ | Ledger key. Defaults to `sandbox-<8char id>` |
| `env` | ❌ | `Record<string, string>` injected into the container |
| `hooks` | ❌ | `SandboxHooks` for observability |
| `shell` | ❌ | Default shell path for all `exec()` calls (default: `/bin/sh`) |
| `timeout` | ❌ | Container lifetime in seconds |
| `entrypoint` | ❌ | Override the container entrypoint — needed for `opensandbox/code-interpreter` |
| `runId` | ❌ | Correlation ID across related sandboxes |

### `sb.exec(cmd)` → `ExecHandle`

`ExecHandle` is `PromiseLike<ExecResult>`. Three usage modes:

```ts
// 1. Await result (buffered)
const { stdout, stderr, exitCode } = await sb.exec("ls -la");

// 2. Stream to a writable
await sb.exec("npm test").pipe(process.stdout);

// 3. Capture stdout as a string
const text = await sb.exec("cat /etc/os-release").stdout();
```

Non-zero exit codes throw `CommandError` with `.exitCode`, `.stdout`, `.stderr`.

### `sb.checkpoint(tag?: string)` → `Promise<string>`

Snapshots the container. Returns the `snapshotId`. Writes `checkpoint_created`
to the ledger. The optional `tag` is persisted in the payload for named resume.

### `client.resume(sandboxId, opts?)` → `Promise<Sandbox>`

Restores the container from the most recent checkpoint (or `opts.tag`). Execs
before the checkpoint return from ledger cache without re-running on the
container. Execs after run live.

### `client.connect(sandboxId, name, opts?)` → `Promise<Sandbox>`

Reconnect to an already-running container. No snapshot involved — the container
keeps its state. Throws 409 if container is not `Running`.

### `client.environment(name, opts)` → `Environment`

Define a named, reusable sandbox environment. The first `env.sandbox()` call
runs the `setup` function and snapshots. Subsequent calls restore from the
cached snapshot.

```ts
const env = client.environment("python", {
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "512Mi" },
  setup: async (sb) => {
    await sb.exec("apt-get update -qq && apt-get install -y python3-pip");
    await sb.exec("pip install numpy pandas");
  },
});

const sb = await env.sandbox();
try {
  await sb.exec("python3 -c 'import pandas; print(pandas.__version__)'").pipe(process.stdout);
} finally {
  await sb.close();
}
```

---

## Storage Adapters

### SQLiteAdapter (local dev)

```ts
import { SQLiteAdapter } from "@alineo-labs/sqlite";

// File-based (creates parent dirs automatically — safe on fresh checkout)
new SQLiteAdapter("./.alineo/ledger.db")

// In-memory (unit tests / throwaway scripts)
new SQLiteAdapter(":memory:")
```

- No `connect()` call needed — the adapter is lazily initialised on first use.
- `process.beforeExit` closes it automatically for scripts.
- Enables WAL mode internally (readers don't block writers).

#### Known Windows quirks with SQLiteAdapter

| Issue | Root cause | Fix already applied |
|---|---|---|
| `SQLITE_CANTOPEN` on first use | `bun:sqlite` doesn't create missing parent directories | `mkdirSync(dirname(path), { recursive: true })` in constructor — ignores `EEXIST` |
| `EBUSY`/`EPERM` during test cleanup | Windows file locks on open DB files during `rmSync` | `try/catch` in test `finally` block — ignores `EBUSY`/`EPERM` |

### PostgresAdapter (production)

```ts
import { PostgresAdapter } from "@alineo-labs/postgres";

new PostgresAdapter("postgresql://user:pass@host:5432/db")
```

Schema is idempotent `CREATE TABLE IF NOT EXISTS` — safe to run on every boot.

---

## CLI Reference (`alineo-cli`)

Run via `bunx alineo-cli <command>` or `alineo <command>` after global install.

| Command | What it does |
|---|---|
| `alineo init` | Start OpenSandbox in Docker, write `alineo.config.json` |
| `alineo agents` | List running agent sessions (ledger + live control-plane) |
| `alineo spawn <spec>` | Load a fresh agent sandbox from a spec file |
| `alineo prompt <id> <msg>` | Resume an agent and send one prompt |
| `alineo fork <name> <spec>` | Attach to a live sandbox and spawn a child agent |
| `alineo kill <id>` | Close a sandbox by ID |
| `alineo logs <name>` | Print ledger events for a session |
| `alineo add <url>` | Fetch and save an agent spec locally |
| `alineo list` | List saved agent specs |
| `alineo remove <name>` | Delete a saved agent spec |

#### Config files

| File | Location | Purpose |
|---|---|---|
| `alineo.config.json` | Project root | `serverUrl`, `useServerProxy`, `adapterPath`, `defaults.resources` |
| `~/.config/alineo/server.toml` | Global | OpenSandbox server config (written by `alineo init`) |

---

## Testing

### Unit tests (no server needed)

```bash
bun run test                      # all packages
bun test packages/adapters/sqlite # one package
bunx tsc --noEmit --strict --project packages/<name>/tsconfig.json  # typecheck one package
```

Use `new SQLiteAdapter(":memory:")` — fast, zero-disk, no cleanup.

**Test lifecycle pattern:**

```ts
import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

let db: SQLiteAdapter;
beforeEach(async () => {
  db = new SQLiteAdapter(":memory:");
  await db.connect();
});
afterEach(async () => {
  await db.close();
});
```

### Integration tests (server required)

```bash
bun run test:integration               # all
cd tests/integration && bun test <name>.test.ts  # one file
```

Requires OpenSandbox running locally. Integration test client setup:

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  adapter: new SQLiteAdapter(":memory:"),
  useServerProxy: true,
});
```

Always wrap the sandbox in `try/finally { await sb.close(); }` — avoids
container leaks and ensures `sandbox_closed` is written to the ledger.

Assert on observable behaviour, not internals:

```ts
const { stdout, exitCode } = await sb.exec("echo hello");
expect(exitCode).toBe(0);
expect(stdout.trim()).toBe("hello");
```

---

## Adding a New Example

```bash
# Scaffold example + matching integration test stub
bun scripts/new-example.ts <name>
# then implement:
#   examples/<name>/index.ts
#   tests/integration/<name>.test.ts
```

---

## Build & Release

```bash
bun run build         # build all packages (tsdown, topologically sorted)
bun run typecheck     # tsc --noEmit across all packages
bunx changeset        # add a changeset (required on every PR touching publishable packages)
bunx changeset status # verify a changeset exists before pushing
```

> **Changesets must be committed** — `bunx changeset status --since origin/main` reads
> from git history, not disk. An uncommitted `.changeset/*.md` will not satisfy CI.

---

## Common Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Server exits immediately with `DOCKER::INITIALIZATION_ERROR` | Docker Desktop socket not exposed inside the container | Ensure Docker Desktop is running; mount `/var/run/docker.sock` (not the Windows pipe) |
| `alineo init` times out with "did not become healthy within 60s" | Container crashes before health endpoint is ready | Check `docker logs alineo-opensandbox` — almost always a socket or config issue |
| `CommandError` with exit code 1 | The command failed inside the sandbox | Check `.stderr` on the error object |
| `AlineoError` status 404 on `resume()` | `sandboxId` not found in the adapter's ledger | Verify you're using the same adapter file path as the original run |
| `AlineoError` status 404 "No checkpoint found" | `resume()` called before any `sb.checkpoint()` | Call `sb.checkpoint()` before the process might crash |
| `resources` not passed to `client.sandbox()` | Server hard-rejects sandbox creation without CPU + memory | Always pass `resources: { cpu: "500m", memory: "256Mi" }` |
| `bun test` hangs after all tests pass | Unclosed DB handles or timers keep the event loop alive | `await db.close()` in `afterEach`; use `:memory:` in tests to avoid file handles |
| `SQLITE_CANTOPEN` on nested path | `bun:sqlite` doesn't mkdir parents | Constructor now calls `mkdirSync(dirname(path), { recursive: true })` |

---

## Verification Checklist

Before committing work on this repo:

- [ ] `bun run test` — all unit tests pass
- [ ] `bun run typecheck` — no TypeScript errors
- [ ] `bun run build` — all packages build cleanly
- [ ] Integration test if touching sandbox lifecycle: `bun run test:integration`
- [ ] Changeset added if touching any publishable package: `bunx changeset`
- [ ] Changeset committed (not just staged): `bunx changeset status --since origin/main`

---

## Resources

- OpenSandbox API reference: `https://deepwiki.com/opensandbox-group/OpenSandbox/`
- Pi agent CLI / RPC: `https://deepwiki.com/earendil-works/pi/`
- Architecture overview: `CLAUDE.md` at the repo root

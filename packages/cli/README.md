# drejx

CLI for [drej](https://drej.dev) — start a local OpenSandbox server, manage saved agent specs, and run/orchestrate `@drej/agent` sessions.

```bash
bunx drejx init
```

Prefer not to run commands manually at all? `pi install npm:drejx` installs the drejx [Pi extension](#pi-extension), which bootstraps `drejx` automatically and teaches Pi its CLI syntax.

---

## SDK — OpenSandbox config and the local spec cache

### `drejx init`

Starts an [OpenSandbox](https://open-sandbox.ai) server in Docker and writes config to `~/.config/drejx/server.toml` and `drej.config.json`.

```bash
drejx init
```

When using a server started this way, `useServerProxy: true` is written into `drej.config.json` automatically — sandbox containers run on Docker's bridge network and aren't reachable directly from the host.

OpenSandbox's own snapshot metadata (what makes `Agent.load()`'s cached-snapshot fast path possible) lives in a SQLite db bind-mounted from `~/.config/drejx/opensandbox-data` into the container — so it survives the container being stopped/started, _and_ being fully removed and recreated (a host reboot with no restart policy, `docker system prune`, a stray `docker rm`). It's only lost if that host directory itself is deleted, or you point a different machine/user at a fresh one. If a cached snapshot ever does fail to restore for some other reason, `Agent.load()` now logs the real error (`[agent] snapshot restore failed (<real error>), rebuilding...`) instead of an undiagnosable `snapshot stale, rebuilding...`.

### `drejx add <url> [--name <n>]`

Fetches an agent spec (JSON) from a URL or local file and saves it under `agentsDir` (default `./agents`).

```bash
drejx add https://registry.drej.dev/agents/python-data.json
```

### `drejx list`

Lists saved agent specs.

```bash
drejx list
```

### `drejx remove <name>`

Removes a saved agent spec.

```bash
drejx remove python-data
```

---

## Agent — session lifecycle

These wrap `@drej/agent`'s `Agent.load()`/`Agent.resume()`/`Agent.attach()`/`Agent.spawn()`. Sessions are always addressed by **sandbox ID**, not name — names aren't unique (running `drejx spawn` twice on the same spec produces two sandboxes with the same name), and a name-based lookup can hand back a sandbox that already died ungracefully. `drejx spawn`/`drejx fork` print the sandbox ID; save it.

### `drejx spawn <spec> [--prompt <msg>] [--rebuild] [--depth <n>] [--max <n>] [--json]`

Start a **brand-new, independent** agent sandbox from a spec's own snapshot. This is the entry point for a fresh session — e.g. a host-level Pi session starting the master of a recursive-agent run.

```bash
drejx spawn ./agents/my-agent.json
drejx spawn ./agents/my-agent.json --prompt "Explain this repo" --json
```

- `--rebuild` forces a full reinstall instead of restoring from the cached snapshot.
- `--depth <n>` overrides the spec's own `spawnDepth` — see [Recursive spawning](#recursive-spawning-drejx-fork) below.
- `--max <n>` overrides the spec's own `maxAgents` — see below.

### `drejx prompt <sandbox-id> <msg> [--spec <path>] [--json]`

Send one prompt to a running sandbox and print the reply.

```bash
drejx prompt 4af65c3b-24a2-4fd1-999d-918faa9b97fd "What's in /tmp?"
```

`--spec <path>` skips the ledger lookup for the spec file — needed when the sandbox's own creation event lives in a different ledger than this CLI invocation's own (e.g. a child spawned via `drejx fork` from inside another sandbox).

### `drejx fork <name> <child-spec> [--prompt <msg>] [--depth <n>] [--max <n>] [--json]`

Fork **your own currently-running session's live sandbox** — filesystem, installed packages, everything on disk right now — into a brand-new independent child. Meant to be run by that session's own Pi bash tool: `name` is the _caller's own_ running session (used only to resolve its sandbox ID; not the child's).

```bash
drejx fork my-session ./agents/worker.json --prompt "Handle the auth module"
```

Unlike `drejx spawn` (always starts from a spec's own snapshot), `drejx fork` sees exactly what the calling sandbox sees right now, including uncommitted work — no install/setup steps run.

### `drejx agents [--json]`

List running agent sessions. Cross-checks the local ledger's "Running" entries against a live query to the OpenSandbox control plane (not just the ledger, which can go stale if a sandbox died ungracefully). Also lists sandboxes running on the same server that weren't created by `drejx` (e.g. agent-spawned children using their own internal ledger).

```bash
drejx agents
```

### `drejx kill <sandbox-id>`

Stop a sandbox.

```bash
drejx kill 4af65c3b-24a2-4fd1-999d-918faa9b97fd
```

### `drejx logs <name> [--json]`

Print ledger events for a session.

```bash
drejx logs my-session
```

### `drejx --version`

Print the installed version.

---

## Recursive spawning (`drejx fork`)

A spec's `spawnDepth` is a nesting-depth budget — required for `drejx fork` to be allowed from inside a session at all. Each fork force-decrements it (`current - 1`) into the child's env; `0` means no budget left, `undefined` means forking was never enabled for that spec.

`maxAgents` is a separate, optional ceiling on total descendants for one lineage, independent of nesting depth. Unset means uncapped. **Not** coordinated across sibling branches spawned in parallel — it's a per-lineage counter, not a global one.

```json
{
  "name": "orchestrator",
  "cli": "pi",
  "spawnDepth": 2,
  "maxAgents": 10
}
```

---

## Pi extension

`pi install npm:drejx` installs the drejx extension into Pi at user scope. Once installed, any Pi session:

- Bootstraps `drejx` automatically on first use (installs it, runs `drejx init`) — no manual setup.
- Gets `drejx spawn`/`drejx fork` CLI syntax injected into its own guidance, dynamically chosen based on whether the current session is itself running inside a drej-managed sandbox.

The extension source lives at `pi-extension/drejx.ts` in this package.

---

## Manual server setup

If you prefer not to use Docker, run the server directly with `uvx`:

```bash
uvx opensandbox-server
```

With `~/.sandbox.toml`:

```toml
[server]
host = "127.0.0.1"
port = 8080

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.19"

[docker]
network_mode = "bridge"

[ingress]
mode = "direct"

[egress]
mode = "dns"
```

With this setup, leave `useServerProxy` unset (defaults to `false`) — the server is on the host, so direct container IPs are reachable.

---

## License

Apache 2.0

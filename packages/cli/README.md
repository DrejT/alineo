# alineo

CLI for [alineo](https://alineo.tech) — start a local OpenSandbox server, manage saved agent specs, and run/orchestrate `@alineo-labs/agent` sessions.

```bash
bunx alineo-cli init
```

Prefer not to run commands manually at all? `pi install npm:alineo` installs the alineo [Pi extension](#pi-extension), which bootstraps `alineo` automatically and teaches Pi its CLI syntax.

---

## SDK — OpenSandbox config and the local spec cache

### `alineo init`

Starts an [OpenSandbox](https://open-sandbox.ai) server in Docker and writes config to `~/.config/alineo/server.toml` and `alineo.config.json`.

```bash
alineo init
```

When using a server started this way, `useServerProxy: true` is written into `alineo.config.json` automatically — sandbox containers run on Docker's bridge network and aren't reachable directly from the host.

OpenSandbox's own snapshot metadata (what makes `Agent.load()`'s cached-snapshot fast path possible) lives in a SQLite db bind-mounted from `~/.config/alineo/opensandbox-data` into the container — so it survives the container being stopped/started, _and_ being fully removed and recreated (a host reboot with no restart policy, `docker system prune`, a stray `docker rm`). It's only lost if that host directory itself is deleted, or you point a different machine/user at a fresh one. If a cached snapshot ever does fail to restore for some other reason, `Agent.load()` now logs the real error (`[agent] snapshot restore failed (<real error>), rebuilding...`) instead of an undiagnosable `snapshot stale, rebuilding...`.

### `alineo add <url> [--name <n>]`

Fetches an agent spec (JSON) from a URL or local file and saves it under `agentsDir` (default `./agents`).

```bash
alineo add https://registry.alineo.tech/agents/python-data.json
```

### `alineo list`

Lists saved agent specs.

```bash
alineo list
```

### `alineo remove <name>`

Removes a saved agent spec.

```bash
alineo remove python-data
```

### `alineo telemetry status|enable|disable`

Shows or changes whether `alineo` sends anonymous usage telemetry — which subcommand ran, a per-command allowlist of boolean flag presence (never values or raw argv), success/failure, and timing. Default-on, sent to `https://telemetry.alineo.tech`.

```bash
alineo telemetry status
# [alineo] telemetry: enabled
#   anonymous id: 3f2e9c1a-8b7d-4e6f-a1c2-9d8e7f6a5b4c
```

Also respects `ALINEO_TELEMETRY_DISABLED=1` and the cross-tool `DO_NOT_TRACK=1` convention, either of which disables telemetry regardless of the persisted config.

---

## Agent — session lifecycle

These wrap `@alineo-labs/agent`'s `Agent.load()`/`Agent.resume()`/`Agent.attach()`/`Agent.spawn()`. Sessions are always addressed by **sandbox ID**, not name — names aren't unique (running `alineo spawn` twice on the same spec produces two sandboxes with the same name), and a name-based lookup can hand back a sandbox that already died ungracefully. `alineo spawn`/`alineo fork` print the sandbox ID; save it.

### `alineo spawn <spec> [--prompt <msg>] [--rebuild] [--depth <n>] [--max <n>] [--json]`

Start a **brand-new, independent** agent sandbox from a spec's own snapshot. This is the entry point for a fresh session — e.g. a host-level Pi session starting the master of a recursive-agent run.

```bash
alineo spawn ./agents/my-agent.json
alineo spawn ./agents/my-agent.json --prompt "Explain this repo" --json
```

- `--rebuild` forces a full reinstall instead of restoring from the cached snapshot.
- `--depth <n>` overrides the spec's own `spawnDepth` — see [Recursive spawning](#recursive-spawning-alineo-fork) below.
- `--max <n>` overrides the spec's own `maxAgents` — see below.

### `alineo prompt <sandbox-id> <msg> [--spec <path>] [--json]`

Send one prompt to a running sandbox and print the reply.

```bash
alineo prompt 4af65c3b-24a2-4fd1-999d-918faa9b97fd "What's in /tmp?"
```

`--spec <path>` skips the ledger lookup for the spec file — needed when the sandbox's own creation event lives in a different ledger than this CLI invocation's own (e.g. a child spawned via `alineo fork` from inside another sandbox).

### `alineo fork <name> <child-spec> [--prompt <msg>] [--depth <n>] [--max <n>] [--json]`

Fork **your own currently-running session's live sandbox** — filesystem, installed packages, everything on disk right now — into a brand-new independent child. Meant to be run by that session's own Pi bash tool: `name` is the _caller's own_ running session (used only to resolve its sandbox ID; not the child's).

```bash
alineo fork my-session ./agents/worker.json --prompt "Handle the auth module"
```

Unlike `alineo spawn` (always starts from a spec's own snapshot), `alineo fork` sees exactly what the calling sandbox sees right now, including uncommitted work — no install/setup steps run.

### `alineo agents [--json]`

List running agent sessions. Cross-checks the local ledger's "Running" entries against a live query to the OpenSandbox control plane (not just the ledger, which can go stale if a sandbox died ungracefully). Also lists sandboxes running on the same server that weren't created by `alineo` (e.g. agent-spawned children using their own internal ledger).

```bash
alineo agents
```

### `alineo kill <sandbox-id>`

Stop a sandbox.

```bash
alineo kill 4af65c3b-24a2-4fd1-999d-918faa9b97fd
```

### `alineo logs <name> [--json]`

Print ledger events for a session.

```bash
alineo logs my-session
```

### `alineo --version`

Print the installed version.

---

## Recursive spawning (`alineo fork`)

A spec's `spawnDepth` is a nesting-depth budget — required for `alineo fork` to be allowed from inside a session at all. Each fork force-decrements it (`current - 1`) into the child's env; `0` means no budget left, `undefined` means forking was never enabled for that spec.

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

`pi install npm:alineo` installs the alineo extension into Pi at user scope. Once installed, any Pi session:

- Bootstraps `alineo` automatically on first use (installs it, runs `alineo init`) — no manual setup.
- Gets `alineo spawn`/`alineo fork` CLI syntax injected into its own guidance, dynamically chosen based on whether the current session is itself running inside a alineo-managed sandbox.

The extension source lives at `pi-extension/alineo.ts` in this package.

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
execd_image = "opensandbox/execd:v1.0.22"

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

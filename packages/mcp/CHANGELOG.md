# alineo-mcp

## 0.2.0

### Minor Changes

- 7f2f39d: New package: `alineo-mcp`, an MCP (Model Context Protocol) server exposing alineod's swarm-control HTTP + SSE API — creating runs, spawning/prompting/steering/pausing/stopping agents, watching live events, resolving results — plus local agent-spec management (`add`/`list`/`remove`) and a Docker bootstrap (`init`), as tools any MCP client (Claude Code, Claude Desktop, Cursor, …) can invoke.

### Patch Changes

- 7f2f39d: No behavior change: `alineo init`'s Docker orchestration, `alineo.config.json`/`server.toml` handling, and the Pi provider API key list were hand-copied between `alineo-cli` and `alineo-mcp` (justified at the time by `alineo-cli` only publishing its `bin`, not these internals as a library entry point) and had already drifted — the `alineo-mcp` copy was missing rationale comments the `alineo-cli` copy had, with no shared import or test to signal when one needed the same fix as the other. Both are now generated from one internal `@alineo-labs/cli-shared` module (private, never published — bundled into each consumer's own `dist` at build time), so `alineo init` and the `alineo_init` MCP tool can no longer silently diverge.
- 7f2f39d: Fix `alineo init` (and the `alineo_init` MCP tool) leaving alineod unreachable on Windows and Mac.

  alineod was started with `--network host` so it could reach OpenSandbox at the same `127.0.0.1` address a bare `bun run start` would — but Docker Desktop for Windows/Mac only publishes `--network host` container ports to the host behind an opt-in "Enable host networking" setting, so alineod would report healthy internally while `alineo_init`'s own health check (and everything else) timed out reaching it.

  On Windows/Mac, alineod now runs on the default bridge network with an explicit port mapping and reaches OpenSandbox via `host.docker.internal`, which Docker Desktop resolves without any special configuration; OpenSandbox's own `eip` is set to match so alineod can also follow the sandbox proxy URLs it hands back. Linux is unaffected — it keeps `--network host`, which works there natively. `alineo_init` also now detects and recreates a container that Docker reports as "running" but isn't actually reachable (the exact failure mode this fixes), and regenerates `server.toml` (restarting whatever's already running) when its `eip` no longer matches what the current platform needs, so existing installs pick up the fix on their next `init` rather than staying stuck.

  Trade-off on Windows/Mac: a host-based client talking to the _same_ `alineo init`-managed OpenSandbox directly (not through alineod) can no longer follow its sandbox proxy URLs, since the host can't reliably resolve `host.docker.internal` back to itself. Use `uvx opensandbox-server` instead for that case (see the root `CLAUDE.md`'s "Local OpenSandbox setup").

- 7f2f39d: Fix regressions from the Windows/Mac `alineo init` networking fix: `server.toml` is no longer clobbered on every `init` (only its `eip` line is patched in place, preserving hand-edited `networkPolicy`/`credentialProxy`/egress settings), the alineod reachability probe no longer false-negatives a healthy-but-slow-to-answer container into a destructive recreate, a wrong host-networking platform guess now falls back to bridge networking + `host.docker.internal` automatically instead of leaving alineod permanently unreachable, `readConfig()` no longer crashes on a partial `defaults` block in `alineo.config.json`, and `alineo add`'s `registryDependencies` resolution now detects circular dependencies instead of looping forever.

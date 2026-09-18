---
"alineo-cli": patch
"alineo-mcp": patch
---

Fix `alineo init` (and the `alineo_init` MCP tool) leaving alineod unreachable on Windows and Mac.

alineod was started with `--network host` so it could reach OpenSandbox at the same `127.0.0.1` address a bare `bun run start` would — but Docker Desktop for Windows/Mac only publishes `--network host` container ports to the host behind an opt-in "Enable host networking" setting, so alineod would report healthy internally while `alineo_init`'s own health check (and everything else) timed out reaching it.

On Windows/Mac, alineod now runs on the default bridge network with an explicit port mapping and reaches OpenSandbox via `host.docker.internal`, which Docker Desktop resolves without any special configuration; OpenSandbox's own `eip` is set to match so alineod can also follow the sandbox proxy URLs it hands back. Linux is unaffected — it keeps `--network host`, which works there natively. `alineo_init` also now detects and recreates a container that Docker reports as "running" but isn't actually reachable (the exact failure mode this fixes), and regenerates `server.toml` (restarting whatever's already running) when its `eip` no longer matches what the current platform needs, so existing installs pick up the fix on their next `init` rather than staying stuck.

Trade-off on Windows/Mac: a host-based client talking to the _same_ `alineo init`-managed OpenSandbox directly (not through alineod) can no longer follow its sandbox proxy URLs, since the host can't reliably resolve `host.docker.internal` back to itself. Use `uvx opensandbox-server` instead for that case (see the root `CLAUDE.md`'s "Local OpenSandbox setup").

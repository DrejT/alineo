# alineo-mcp

## 0.2.1

### Patch Changes

- de786a7: Config is now found, merged and validated in one place.

  `alineo.config.json` is located by walking up from the working directory (bounded by a `.git`
  directory, `$HOME`, or the filesystem root) instead of being read only from the exact working
  directory. Running a script from a subdirectory previously fell back to built-in defaults in
  silence, which looked identical to having no config at all.

  Sources are merged lowest-first — `~/.config/alineo/config.json`, then `alineo.config.json`,
  then `ALINEO_CONFIG_CONTENT` (inline JSON), then `ALINEO_SERVER_URL` / `ALINEO_API_KEY` /
  `ALINEO_USE_SERVER_PROXY`, then explicit options — validated once, then frozen. A malformed file
  or a bad value now fails with the offending key and file named, rather than being dropped.

  `Alineo.load()`, `.resume()`, `.reattach()` and `.attach()` accept `opts.config` to skip file and
  environment discovery entirely, for embedded callers and tests that must not depend on the
  working directory. The config is also read once per working directory now, not on every call.

  Three behaviour changes worth noting.

  A project config found by walking up will now apply where defaults were previously used.

  A global `~/.config/alineo/config.json` is merged under a project config instead of being ignored
  whenever a project config exists. The SDK previously ignored the global config entirely while
  `alineo-cli` already read it, so on a machine with a global config and no project config the two
  disagreed about `adapterPath` — and therefore used different agent snapshot caches. They now
  agree. If that describes your setup, the first `Alineo.load()` of each spec after upgrading
  rebuilds its snapshot at the new location instead of reusing the old one; nothing is lost, but
  expect one slow run per spec.

  A spec that relied on the built-in `adapterPath`/`agentsDir` defaults while a global config set
  different ones will now follow the global config. Pass `opts.config`, or set the value explicitly
  in a project `alineo.config.json`, to pin it.

- db86c50: `alineo-mcp` now reports its real package version in the MCP `initialize` handshake (it was hardcoded to `0.1.0`), and its README no longer says the package is unpublished. Adds a docs page at `/docs/alineod/getting-started/mcp`.
- Updated dependencies [de786a7]
- Updated dependencies [de786a7]
  - alineo@0.7.0

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
- Updated dependencies [7f0d5c2]
  - alineo@0.6.0

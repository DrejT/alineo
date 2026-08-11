---
"drejx": patch
"@drej/agent": patch
---

Fix `drejx init`'s Docker container silently losing every cached agent snapshot whenever it's
removed and recreated (host reboot with no restart policy, `docker system prune`, a stray
`docker rm`) — not just restarted. OpenSandbox itself persists snapshot metadata durably in a
SQLite db meant to survive the server process restarting, but `drejx init` never bind-mounted
that db's directory to the host, so it only ever survived alongside the container's own
lifecycle. `~/.config/drejx/opensandbox-data` is now bind-mounted into the container at `/data`,
with `[store].path` pinned explicitly in the generated `server.toml`, so the durability
guarantee OpenSandbox already provides actually holds (fixes #20).

Also: `Agent.load()`'s snapshot-restore fallback now logs the real error instead of a bare
"snapshot stale, rebuilding..." — useful for any other reason a cached snapshot might fail to
restore, not just this one.

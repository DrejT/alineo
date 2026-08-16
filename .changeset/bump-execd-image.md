---
"alineo-cli": patch
---

Bump the `execd` image `alineo init` pins in the generated `server.toml` from `v1.0.19` to
`v1.0.22`. v1.0.19 predates cached bwrap-archive support, so every sandbox logged "bwrap
archive not cached for linux/amd64 -- isolation will be unavailable" and the warning's own
suggested fix ("upgrade execd image to v1.1.0+") pointed at a tag that was never actually
published. Per OpenSandbox's docs, `execd` >=v1.0.20 has base isolation-session support and
>=v1.0.21 is recommended for full functionality; v1.0.22 is the latest published patch.

Note: this resolves the stale-image warning and lets execd's own isolation probe run cleanly,
but does not by itself enable bwrap isolation end-to-end -- that additionally requires the
sandbox-creation request to opt into `bootstrap.execd.isolation`, which grants the container
`CAP_SYS_ADMIN` and unconfined apparmor/seccomp. This SDK does not do that by default (and
deliberately doesn't turn it on unconditionally, since it would weaken every sandbox's default
container security posture just to support a rarely-used feature) -- pause()/resume() and
isolation-session-dependent features remain unavailable out of the box pending a real opt-in
API for this.

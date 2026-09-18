---
"alineo-cli": patch
"alineo-mcp": patch
---

Fix regressions from the Windows/Mac `alineo init` networking fix: `server.toml` is no longer clobbered on every `init` (only its `eip` line is patched in place, preserving hand-edited `networkPolicy`/`credentialProxy`/egress settings), the alineod reachability probe no longer false-negatives a healthy-but-slow-to-answer container into a destructive recreate, a wrong host-networking platform guess now falls back to bridge networking + `host.docker.internal` automatically instead of leaving alineod permanently unreachable, `readConfig()` no longer crashes on a partial `defaults` block in `alineo.config.json`, and `alineo add`'s `registryDependencies` resolution now detects circular dependencies instead of looping forever.

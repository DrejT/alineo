---
"alineo-cli": minor
---

`alineo init` now also pulls and starts `alineod` (`ghcr.io/drejt/alineod:latest`) alongside
OpenSandbox, on `--network host` so it can reach OpenSandbox at the same `127.0.0.1:8080` a bare
`bun run start` would — a bridge-network container can't resolve the sandbox proxy URLs
OpenSandbox hands back, which are built from its own configured `eip`. No model API key is
required to start; agents whose spec references a missing one will fail at spawn time, not at
daemon startup. Re-running `init` is idempotent: an already-running or stopped `alineo-alineod`
container is left running or restarted, never recreated.

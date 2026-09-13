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

Model-agnostic: `init` forwards whichever of Pi's ~30 supported provider API key env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ... — see
`packages/cli/src/pi-model-keys.ts`) are already set in the operator's shell into the container,
not just `NVIDIA_API_KEY`. An `AgentSpec`'s env map is resolved from `process.env` inside
whichever process calls `Alineo.load()`/`.spawn()`, so any Pi-supported provider works as long
as its key is set locally. Amazon Bedrock and Google Vertex aren't covered yet — both need a
mounted credentials file or IAM role chain, not just an env var.

# CLI Reference (`alineo-cli`)

Run via `bunx alineo-cli <command>` or `alineo <command>` after global install.

| Command | What it does |
|---|---|
| `alineo init` | Start OpenSandbox **and alineod** in Docker (see [below](#alineod-the-swarm-daemon)), write `alineo.config.json` |
| `alineo agents` | List running agent sessions (ledger + live control-plane) |
| `alineo spawn <spec>` | Load a fresh agent sandbox from a spec file — **direct SDK call, does not go through alineod** even if it's running |
| `alineo prompt <id> <msg>` | Resume an agent and send one prompt |
| `alineo fork <name> <spec>` | Attach to a live sandbox and spawn a child agent |
| `alineo steer <sandbox-id> <msg>` | Redirect a running session — via `Alineo.reattach()`; lands at the session's next turn boundary, not instantly |
| `alineo kill <id>` | Close a sandbox by ID |
| `alineo logs <name>` | Print ledger events for a session |
| `alineo add <url>` | Fetch and save an agent spec locally |
| `alineo list` | List saved agent specs |
| `alineo remove <name>` | Delete a saved agent spec |
| `alineo telemetry status\|enable\|disable` | Anonymous usage telemetry toggle |

#### Config files

| File | Location | Purpose |
|---|---|---|
| `alineo.config.json` | Project root | `serverUrl`, `useServerProxy`, `adapterPath`, `defaults.resources` |
| `~/.config/alineo/server.toml` | Global | OpenSandbox server config (written by `alineo init`) |

## alineod (the swarm daemon)

Since `0.1.0`, `alineo init` pulls `ghcr.io/drejt/alineod:latest` and starts it as a **second**
container (`alineo-alineod`, port 4600) alongside OpenSandbox (`alineo-opensandbox`, port 8080) —
check both with `docker ps`, not just one. It runs on `--network host`, not a port mapping: alineod
must reach OpenSandbox at the same `127.0.0.1:8080` a bare `bun run start` would, since OpenSandbox
hands back sandbox proxy URLs built from its own configured `eip` (`127.0.0.1:8080`) that a
bridge-network container can't resolve.

**Model API key**: `init` scans the shell it's run from for any of these Pi-supported provider key
env vars (`packages/cli-shared/src/pi-model-keys.ts`, mirroring pi's own `env-api-keys.ts` — keep
in sync as pi adds providers) and forwards whichever are set into the container:

`ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
`AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`,
`CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_GATEWAY_ID`), `RADIUS_API_KEY`,
`OPENCODE_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`, `MOONSHOT_API_KEY`,
`KIMI_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`,
`XIAOMI_API_KEY` (+ 3 regional token-plan variants), `ANT_LING_API_KEY`, `HF_TOKEN`,
`FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `BASETEN_API_KEY`, `COPILOT_GITHUB_TOKEN`.

Not covered (need a mounted credentials file or IAM role chain, not just an env var): Amazon
Bedrock, Google Vertex.

**No key is required to start** — alineod boots fine either way; only a run whose agent spec
references a missing key fails, at spawn time. Docker env is fixed at container creation: to
add/change a key on an already-running daemon, `docker rm -f alineo-alineod` first, then re-run
`init` (or `docker run`) with the new key exported.

**Picking a `model` value**: `provider`/`model` in an agent spec (or `setModel(provider, modelId)`)
take Pi's own provider/model IDs, not alineo's — this skill doesn't enumerate them since Pi's
catalog changes independently. Use `agent.getAvailableModels()` (see
[Agent SDK](agent-sdk.md)) to list what's actually available under whichever key you set above,
rather than guessing a model ID string.

**What alineod actually is, and what it isn't**: it's a separate HTTP+SSE swarm-orchestration
process, not something this skill's `alineo spawn`/`fork`/`prompt`/`steer` commands talk to — those
call the `Alineo` SDK class **directly**, in-process, regardless of whether alineod is running.
alineod itself is built by calling that same `Alineo.load()`/`.spawn()` API **server-side**, from
inside its own process, driven by its HTTP routes (`POST /runs`, `POST /runs/:id/agents`, `waitFor`
gather, `/steer`, `/pause`/`/resume`, SSE `/runs/:id/events`, ...). There is currently no CLI
subcommand that creates a run *through* alineod — you `curl -X POST localhost:4600/runs -d
'{"spec": ..., "prompt": ...}'` directly, or run a script (`apps/alineod/scripts/demo-swarm.py`,
any `cookbooks/*/index.ts`). Full API + quickstart: `apps/alineod/README.md` and
`/docs/alineod`.

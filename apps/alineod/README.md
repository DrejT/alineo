# alineod

The swarm control daemon — **prototype**, on the `prototype/alineod` branch, off `main`.

Design: [`research/daemon.md`](../../../research/daemon.md). This is the v0 described there.

```
client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
```

alineod exposes an HTTP + SSE API for initiating and orchestrating agent swarms. Internally it
drives OpenSandbox through the `alineo` SDK (`Alineo.load` / `.spawn` / `.prompt` / `.abort`).
The **protocol** is this daemon's wire contract — `specs/alineod/openapi.json` +
`events.schema.json`, emitted from the Zod schemas in `src/schema.ts`.

## Run

### Bare

```bash
bun run start          # or: bun run dev   (watch mode)
```

Run it from a directory that has an `alineo.config.json` (or rely on the SDK defaults:
`http://127.0.0.1:8080`, `useServerProxy: true`). Env: `ALINEOD_PORT` (4600), `ALINEOD_DB_PATH`,
`ALINEOD_SDK_LEDGER_PATH`, `ALINEOD_WORK_DIR`, `ALINEOD_PROMPT_INACTIVITY_MS`.

### Docker

```bash
# from the repo root (the build needs the whole monorepo to build the SDK)
docker build -f apps/alineod/Dockerfile -t alineod .

docker run --rm -p 4600:4600 \
  --add-host host.docker.internal:host-gateway \
  -e ALINEO_SERVER_URL=http://host.docker.internal:8080 \
  -e NVIDIA_API_KEY=nvapi-... \
  -v alineod-data:/data \
  alineod
```

or `NVIDIA_API_KEY=nvapi-... docker compose -f apps/alineod/docker-compose.yml up --build`.

The `docker-entrypoint.sh` writes `/data/alineo.config.json` from the `ALINEO_SERVER_URL` /
`ALINEO_USE_SERVER_PROXY` / `ALINEO_API_KEY` env before starting the server. State
(`/data`) is a volume — the crash-only design means the container can be recreated freely.

**Networking caveat:** the container reaches OpenSandbox over HTTP (it does *not* need the
Docker socket — OpenSandbox owns container creation). But in server-proxy mode OpenSandbox
hands back sandbox URLs built from its own configured `eip`; if that's `http://localhost:8080`
it won't resolve from inside the alineod container. Either put alineod on the same Docker
network as OpenSandbox with a routable `eip`, or run alineod with `--network host` (same as
running it bare).

## Emit the protocol spec

```bash
bun run spec           # writes specs/alineod/{openapi.json,events.schema.json}
```

## Routes (v0)

| Method | Path | |
|---|---|---|
| POST | `/runs` | create a run, load the root agent, optional first `prompt` |
| GET | `/runs/:runId` | the spawn tree (flat list + parent pointers, `asOf` seq) |
| DELETE | `/runs/:runId` | abort + close every live agent; **ledger kept** |
| GET | `/runs/:runId/events` | SSE — the whole swarm on one stream, `Last-Event-ID` aware |
| POST | `/runs/:runId/agents` | spawn a child (`parentAgentId`, optional `waitFor`, `prompt`) |
| GET | `/agents/:agentId` | inspect + `sessionStats` |
| POST | `/agents/:agentId/prompt` | drive a turn |
| POST | `/agents/:agentId/stop` | abort + close |
| GET | `/agents/:agentId/result` | resolve a handle (`?wait=<seconds>` long-poll) |

## State (`bun:sqlite`, `src/state/db.ts`)

- `ledger` — append-only, the source of truth; `seq` is the SSE `Last-Event-ID` marker
- `agents` — the spawn tree projection, refoldable from the ledger
- `handles` — one row per agent another agent can `waitFor`

On boot, `rehydrate.ts` refolds the projections and reconnects to every live sandbox
(`Alineo.resume`). Agents are OpenSandbox containers, not children of this process, so a
restart does not disturb a running swarm.

## Prototype shortcuts (deliberate)

- **Zod, not Elysia's TypeBox.** Routes validate bodies with the Zod schemas directly; the
  OpenAPI document is generated from the same schemas by `scripts/emit-spec.ts` rather than
  introspected from the Elysia app. Split on purpose — keeps runtime behaviour predictable
  while the `@elysiajs/openapi` + Standard-Schema path is still the one integration risk.
- **Results are inline text.** A settled handle stores the agent's last assistant text under
  `data/alineod-work/results/`. The real scheme is a by-reference `fs://<agentId>/<path>`
  into the sandbox (D-d).
- **`waitFor` is hold-then-spawn.** The child is not created until its deps settle; their
  results are then written into its sandbox as `/inputs/<agentId>.txt` + `/inputs.json` (D-c).
- **Budget enforcement is the SDK's.** `Alineo.spawn()` throws when `spawnDepth` / `maxAgents`
  are exhausted; alineod catches it and emits `budget_denied` + 409.
- **`Alineo.resume` on rehydrate restarts the bridge** (drops an in-flight turn). The real
  fix is an SDK "attach from control plane" path (D-a).

## Not in v0

Selectors beyond one agent / subtree · checkpoint & rollback · `steer` / `interrupt` /
`rebudget` · context-policy knobs · channels / `notifyWhen` / quiescence / deadlock detection
· the authority model. See [`research/open-questions.md`](../../../research/open-questions.md).

## Known issues

- **`GET /agents/:id/result?wait=` long-poll can hang past settle** in some cases (the held
  request doesn't always return when the handle settles mid-wait). `?wait=0` polling works
  reliably — `demo-swarm.py` polls. Under investigation.
- **`POST /runs` and `POST /runs/:id/agents` are synchronous** — they block for the full
  sandbox provision (~70s cold, ~12s snapshot-fork). `curl` times out while the server keeps
  working. Async `202 + provisioning` state is the fix.
- **Some NIM models stall mid-turn** on multi-tool-call turns; `driveTurn` bounds this with
  `inactivityTimeoutMs` (default 180s) and settles with partial text.

## No tests yet

Code only, per the prototype plan. Test surface will follow.

## Verified on the VPS (2026-09-10)

A 5-agent fan-out/gather swarm — `coordinator` + 3 haiku workers + a `gather` that
`waitFor`s all three — runs green end to end. The gather agent reads the workers' outputs
from `/inputs.json` + `/inputs/*.txt` in its sandbox and assembles the final poem;
`GET /agents/:id/result` returns it with `resultRef: fs://<agentId>/result.md`.

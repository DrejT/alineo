# alineod

The swarm control daemon — HTTP + SSE orchestration for swarms of sandboxed agents.

Design: [`research/daemon.md`](../../../research/daemon.md).

**User docs:** `apps/docs/content/docs/alineod/` — published at `/docs/alineod` (quickstart, deployment,
guides, HTTP API and event reference).

```
client ── HTTP + SSE ──▶ alineod ── in-process ──▶ alineo SDK ──▶ OpenSandbox + Pi
```

alineod exposes an HTTP + SSE API for initiating and orchestrating agent swarms. Internally it
drives OpenSandbox through the `alineo` SDK (`Alineo.start` / `.spawn` / `.prompt` / `.abort`).
The **protocol** is this daemon's wire contract — `specs/alineod/openapi.json` +
`events.schema.json`, emitted from the Zod schemas in `src/schema.ts`.

## Run

### Bare

```bash
bun run start          # or: bun run dev   (watch mode)
```

Run it from a directory that has an `alineo.config.json` (or rely on the SDK defaults:
`http://127.0.0.1:8080`, `useServerProxy: true`). Env: `ALINEOD_PORT` (4600), `ALINEOD_DB_PATH`,
`ALINEOD_SDK_LEDGER_PATH`, `ALINEOD_WORK_DIR`, `ALINEOD_PROMPT_INACTIVITY_MS`, `ALINEOD_TURN_MAX_MS`,
`ALINEOD_CATCH_UP_POLL_MS`, `ALINEOD_STATE_PROBE_TIMEOUT_MS`, `ALINEOD_RESUME_BRIDGE_TIMEOUT_MS`.

### Docker

`alineo init` pulls `ghcr.io/drejt/alineod:latest` and starts it automatically alongside
OpenSandbox — on `--network host` so it reaches OpenSandbox at the same `127.0.0.1:8080`
a bare `bun run start` would (see the networking caveat below), with no model API key set.
Add one after the fact (`docker run -e NVIDIA_API_KEY=... --network host ... ghcr.io/drejt/alineod:latest`,
or edit agent specs to reference a different env var) — alineod boots fine without one; only
agents whose spec references a missing key will fail at spawn time. The image is published by
[`.github/workflows/publish-alineod.yml`](../../.github/workflows/publish-alineod.yml) on every
push to `main` that touches `apps/alineod` or a package it bundles, tagged with
`apps/alineod/package.json`'s version plus `latest`.

To build from source instead (e.g. testing an unreleased change):

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

**Networking caveat:** the container reaches OpenSandbox over HTTP (it does _not_ need the
Docker socket — OpenSandbox owns container creation). But in server-proxy mode OpenSandbox
hands back sandbox URLs built from its own configured `eip`; if that's `http://localhost:8080`
it won't resolve from inside the alineod container. Either put alineod on the same Docker
network as OpenSandbox with a routable `eip`, or run alineod with `--network host` (same as
running it bare).

## Emit the protocol spec

```bash
bun run spec           # writes specs/alineod/{openapi.json,events.schema.json}
```

## Routes

| Method | Path                      |                                                               |
| ------ | ------------------------- | ------------------------------------------------------------- |
| POST   | `/runs`                   | create a run, load the root agent, optional first `prompt`    |
| GET    | `/runs/:runId`            | the spawn tree (flat list + parent pointers, `asOf` seq)      |
| DELETE | `/runs/:runId`            | abort + close every live agent; **ledger kept**               |
| GET    | `/runs/:runId/events`     | SSE — the whole swarm on one stream, `Last-Event-ID` aware    |
| POST   | `/runs/:runId/agents`     | spawn a child (`parentAgentId`, optional `waitFor`, `prompt`) |
| GET    | `/agents/:agentId`        | inspect + `sessionStats` (omitted while paused; 2s bound)     |
| POST   | `/agents/:agentId/prompt` | drive a turn                                                  |
| POST   | `/agents/:agentId/steer`  | redirect the current turn (lands at the next turn boundary)   |
| POST   | `/agents/:agentId/pause`  | freeze the agent's container                                  |
| POST   | `/agents/:agentId/resume` | thaw a paused container                                       |
| POST   | `/agents/:agentId/stop`   | abort + close                                                 |
| GET    | `/agents/:agentId/result` | resolve a handle (`?wait=<seconds>` long-poll)                |

## State (`bun:sqlite`, `src/state/db.ts`)

- `ledger` — append-only, the source of truth; `seq` is the SSE `Last-Event-ID` marker
- `agents` — the spawn tree projection, refoldable from the ledger
- `handles` — one row per agent another agent can `waitFor`

On boot, `rehydrate.ts` refolds the projections and reconnects to every live sandbox
(`Alineo.reattach`, falling back to `Alineo.resume`), then retries any spawn that hadn't forked
yet. Agents are OpenSandbox containers, not children of this process, so a restart does not
disturb a running swarm.

## Design notes

- **Zod, not Elysia's TypeBox.** Routes validate bodies with the Zod schemas directly; the
  OpenAPI document is generated from the same schemas by `scripts/emit-spec.ts` rather than
  introspected from the Elysia app, which keeps runtime validation predictable.
- **Results are inline text.** A settled handle stores the agent's last assistant text under
  `data/alineod-work/results/`, addressed as `fs://<agentId>/result.md`. Resolving references
  to arbitrary paths inside the sandbox is planned (D-d).
- **`waitFor` is hold-then-spawn.** The child is not created until its deps settle; their
  results are then written into its sandbox as `/inputs/<agentId>.txt` + `/inputs.json` (D-c).
- **Budgets are owned by alineod.** It passes each parent's remaining `spawnDepth` /
  `maxAgents` to `Alineo.spawn()`, which refuses when exhausted; alineod turns that into
  `budget_denied` and ends the child as `budget-exceeded`.
- **Rehydrate reconnects live agents AND finished-but-open ones.** A `done`/`failed` turn
  doesn't close its sandbox, so it stays promptable / usable as a spawn parent — rehydrate
  reconnects those too, not just `provisioning`/`spawning`/`running`/`paused`, so that survives
  a restart. It tries `Alineo.reattach()` first, falling back to `Alineo.resume()` (which
  restarts the bridge, dropping an in-flight turn) only if the bridge doesn't answer (D-a). If
  both fail: a still-live agent ends `lost`; a finished agent keeps its real outcome.
- **Pause, resume and stop can take a subtree.** `{"scope": "subtree"}` acts on an agent and every
  descendant (pause parents first; resume and stop leaves first), returning one result per member.
  `pausedBy` records whether each was the target (`operator`) or reached by the cascade. Steer's
  subtree form delivers one message to the parent (plus a roster of its children) — never a
  broadcast. Stopping a finished agent emits `agent_released` and keeps its outcome.
- **Coordination.** `waitFor` modes (`settled`/`all`/`any`/`quorum`) plus deadlines; quiescence and
  operator await routes; `notifyOn` with a per-agent inbox delivered by the subscriber's state.

## Not yet supported

Agent-initiated coordination (an agent's own `await` / `notifyWhen`) · checkpoint & rollback · `interrupt` /
`rebudget` · context-policy knobs · channels · the authority model.
See [`research/open-questions.md`](../../../research/open-questions.md).

## Known issues

- **Some NIM models stall mid-turn** on multi-tool-call turns. When a stream goes quiet for
  `ALINEOD_PROMPT_INACTIVITY_MS` (180s), alineod follows the turn by polling Pi's state; a turn
  still running after `ALINEOD_TURN_MAX_MS` (30 min, paused time excluded) settles with partial text.
- **`stop` with `mode: "drain"`** currently behaves the same as `abort`.

## Scripts

- `scripts/demo-swarm.py [BASE_URL]` — a 5-agent fan-out/gather run end to end.
- `scripts/swarm-reattach-test.py` — a multi-agent run for exercising crash recovery.

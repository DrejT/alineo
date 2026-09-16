# alineod-swarm

Drives a small agent swarm through [alineod](../../apps/alineod)'s HTTP + SSE API — no SDK, just
`fetch`:

1. create a run with a root agent — `POST /runs`
2. watch every agent in the run live — `GET /runs/:runId/events`
3. fan out to three haiku workers, each forked from the root — `POST /runs/:runId/agents`
4. pause and resume one worker's container — `POST /agents/:id/pause`, `/resume`
5. steer another worker mid-turn — `POST /agents/:id/steer`
6. gather: a fourth agent `waitFor`s the workers and reads their results from `/inputs/`
7. long-poll the final poem — `GET /agents/:id/result?wait=`
8. tear the run down — `DELETE /runs/:runId`

## Setup

```bash
bunx alineo-cli init          # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build  # from the repo root
```

Start alineod in its own terminal, with your NVIDIA key in **its** environment — agent specs
reference `${NVIDIA_API_KEY}`, resolved by the daemon, so the key never travels in a request:

```bash
cd apps/alineod
NVIDIA_API_KEY=nvapi-... bun run start
```

## Run

```bash
bun start
```

Set `ALINEOD_URL` if the daemon isn't on `http://localhost:4600`.

For subtree pause/stop/steer, quorum waits and `notifyOn`, see
[`alineod-coordination`](../alineod-coordination).

See the [alineod docs](https://docs.alineo.tech/docs/alineod) for every route and event.

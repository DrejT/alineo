# alineod-auth

alineod's optional authentication, spec env allowlist and open-run limit, all set with environment
variables when the daemon starts. It uses `fetch` directly, with no SDK, and makes no model call, so
it needs no model key.

| Variable                                | Effect in this example                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `ALINEOD_AUTH_TOKEN=demo-token`         | Every request except `GET /health` needs `Authorization: Bearer demo-token`. |
| `ALINEOD_SPEC_ENV_ALLOW=NVIDIA_API_KEY` | A spec's `env` may read only `${NVIDIA_API_KEY}` from alineod's environment. |
| `ALINEOD_MAX_OPEN_RUNS=1`               | One open run at a time.                                                      |

What the script checks, in order:

1. `GET /health` answers with no token, so a load balancer can probe it.
2. Any other request with no token, or a wrong one, gets `401 UNAUTHENTICATED`.
3. A spec whose `env` reads `${HOME}` gets `400 INVALID_ARGUMENT`. No sandbox is made.
4. A spec that reads only `${NVIDIA_API_KEY}` starts a run (`202`), and `GET /runs` lists it.
5. A second open run gets `429 LIMIT_EXCEEDED`.
6. After `DELETE /runs/:runId` (`204`), a new run starts again.

With one shared token, every caller is the same tenant. To keep several tenants apart, see the
[`hosted-mcp`](../../cookbooks/hosted-mcp) cookbook, which passes an `authenticate` function to
`startDaemon()`.

## Setup

```bash
bunx alineo-cli init          # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build  # from the repo root
```

Start alineod in its own terminal with the three variables:

```bash
cd apps/alineod
ALINEOD_AUTH_TOKEN=demo-token \
ALINEOD_SPEC_ENV_ALLOW=NVIDIA_API_KEY \
ALINEOD_MAX_OPEN_RUNS=1 \
bun run start
```

## Run

```bash
bun start
```

Set `ALINEOD_URL` if the daemon is not on `http://localhost:4600`, and `ALINEOD_API_KEY` if you
chose a token other than `demo-token`. The script takes a few seconds. alineod closes each
sandbox it started, also one that is still being made when its run is closed.

See [Security](https://docs.alineo.tech/docs/alineod/deployment#security) and
[Limits and suspension](https://docs.alineo.tech/docs/alineod/deployment#limits-and-suspension).

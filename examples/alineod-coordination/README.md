# alineod-coordination

A tagline team run through [alineod](../../apps/alineod)'s subtree controls and coordination
primitives. It uses `fetch` directly, with no SDK:

```text
coordinator (root)
├─ lead
│  ├─ drafter-bold
│  ├─ drafter-calm
│  └─ drafter-slow        takes ~2 minutes
├─ judge                  waitFor { mode: "quorum", k: 2 } on the drafters
└─ editor                 notifyOn [drafter-slow], keeps working meanwhile
```

1. pause and resume the lead's whole subtree — `POST /agents/:id/pause`, `/resume` with `{ "scope": "subtree" }`
2. steer the subtree through its parent — `POST /agents/:id/steer` with `{ "scope": "subtree" }`. The lead
   gets one message with its children's roster.
3. start the judge as soon as any two drafters succeed — `waitFor: { mode: "quorum", k: 2 }`
4. tell the editor when the slow drafter finishes, without blocking it — `notifyOn`, `GET /agents/:id/inbox`
5. wait on agents without spawning anything — `POST /runs/:runId/await`, `GET /agents/:id/await?scope=subtree`
6. stop the lead's whole subtree — `POST /agents/:id/stop` with `{ "scope": "subtree" }`

Start with [`alineod-swarm`](../alineod-swarm) if you haven't used alineod yet.

## Setup

```bash
bunx alineo-cli init          # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build  # from the repo root
```

Start alineod in its own terminal, with your NVIDIA key in **its** environment. Agent specs
reference `${NVIDIA_API_KEY}`, which the daemon resolves, so the key never travels in a request:

```bash
cd apps/alineod
NVIDIA_API_KEY=nvapi-... bun run start
```

## Run

```bash
bun start
```

Set `ALINEOD_URL` if the daemon isn't on `http://localhost:4600`. A run takes a few minutes: seven
sandboxes, one of them sleeping for two.

See [Coordination](https://docs.alineo.tech/docs/alineod/concepts/coordination) and
[Steering and pausing](https://docs.alineo.tech/docs/agent/concepts/steering).

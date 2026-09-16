# swarm-code-review

A code review run by a swarm of agents, orchestrated through [alineod](../../apps/alineod):

```
review-lead ── clones expressjs/cors once
  ├── reviewer: security      ┐
  ├── reviewer: correctness   ├─ forked from the lead's sandbox — the checkout is already there
  ├── reviewer: tests         ┘
  └── editor ── waits for all three, merges their findings into one report
```

## Setup

```bash
bunx alineo-cli init          # starts OpenSandbox in Docker (one-time setup)
bun install && bun run build  # from the repo root
```

Start alineod in its own terminal, with an NVIDIA key ([build.nvidia.com](https://build.nvidia.com),
free tier available) in **its** environment:

```bash
cd apps/alineod
NVIDIA_API_KEY=nvapi-... bun run start
```

## Run

```bash
bun install
bun start
```

Set `ALINEOD_URL` if the daemon isn't on `http://localhost:4600`.

## What it does

1. **Checks out the repository once.** `agents/lead.json` installs `git` and clones
   `expressjs/cors` as a setup step. The lead's first turn reports the commit being reviewed.
2. **Forks a reviewer per concern** — security, correctness, and test coverage. Each is a fork of
   the lead's live sandbox, so every reviewer starts with the checkout already on disk; nothing is
   cloned twice. Each spawn carries an `idempotencyKey`, so a retried request can't create a
   duplicate reviewer. The lead's `spawnDepth: 1` and `maxAgents: 5` cap how far the swarm can grow.
3. **Intervenes mid-review.** It pauses the tests reviewer's container for five seconds and resumes
   it, and steers the security reviewer onto a narrower brief — neither agent restarts.
4. **Gathers.** The editor is spawned with `waitFor` on all three reviewers. alineod holds it until
   they finish, then writes each reviewer's findings into its sandbox under `/inputs/`, with an
   `/inputs.json` manifest that includes each reviewer's outcome.
5. **Reports.** The merged report is printed and written to `review.md`, followed by the final
   agent tree. The run is then deleted, which closes every sandbox.

Progress for every agent in the swarm streams over a single `GET /runs/:runId/events` connection.

To review a different repository, change the clone URL in `agents/lead.json` and the paths and
concerns in `index.ts`.

See the [alineod docs](https://docs.alineo.tech/docs/guide/swarms) for every route and event.

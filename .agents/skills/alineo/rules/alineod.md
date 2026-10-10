# alineod (the swarm daemon)

alineod is a separate HTTP+SSE process (Bun + Elysia + `bun:sqlite`, image `ghcr.io/drejt/alineod`,
port 4600) that drives the `Alineo` SDK server-side to run many agents as one swarm. `alineo init`
starts it. Version at time of writing: `0.1.x`. Full docs: `/docs/alineod`
(`apps/docs/content/docs/alineod/`), API detail: `apps/alineod/README.md`.

The wire contract is Zod in `apps/alineod/src/schema.ts`, derived from `@alineo-labs/schema`.
The CLI does **not** talk to it (there is no `alineo run` command): use `curl`, a script
(`cookbooks/*/index.ts`, `apps/alineod/scripts/`), or the MCP server below.

## Model

- **Run** — a tree of agents under one root. `POST /runs {spec, prompt?, budget?, closeWhen?}`.
  The response returns `provisioning`; poll for the real state.
- **Agent** — a node in the tree. Children are spawned by the parent (or by a client) with
  `POST /runs/:runId/agents`.
- **Ledger** — a single append-only `ledger` table is the source of truth. `agents` and `handles`
  are caches rebuilt from it by `projection.ts` (crash-only design). Every state change goes
  through `engine/emit.ts`; changes there stay strictly additive.

## HTTP surface

Paths follow `/{subjects}/:id/{verb}` and are checked in CI.

| Route | Does |
|---|---|
| `POST /runs`, `GET /runs/:id`, `DELETE /runs/:id` | create / inspect / close a run |
| `GET /runs/:id/events` | SSE stream of the run's events (`Last-Event-ID` resumes) |
| `POST /runs/:id/await` | wait on a set of agents (`settled`/`all`/`any`/`quorum`) |
| `POST /runs/:id/agents` | spawn an agent (optionally with `waitFor`, `notifyOn`) |
| `GET /agents/:id`, `/agents/:id/transcript`, `/agents/:id/await` | inspect / read / wait |
| `POST /agents/:id/prompt` · `steer` · `pause` · `resume` · `stop` | drive an agent. `pause`/`resume`/`stop`/`steer` take `idempotencyKey`; `pause`/`resume`/`stop` take `scope: "agent"` (default) or `"subtree"` |
| `POST /agents/:id/notify-on`, `GET /agents/:id/inbox`, `POST .../inbox/deliver` | parent notification |
| `GET/PUT/DELETE /agents/:id/memory[/:key]`, `POST/GET .../facts`, `POST .../compactions` | agent memory |
| `GET /health` | liveness |

## Budgets and run lifetime

- `budget: { spawnDepth, maxAgents }` on `POST /runs` overrides the spec's own values.
- `closeWhen: "explicit"` (default) keeps a run open until `DELETE`. `"quiescent"` closes it the
  moment every agent is terminal with nothing left to deliver.
- Provisioning goes through admission control, so a fan-out cannot exceed what the host can start.
- `pause`/`resume`/`stop` against the same agent are serialized; the `idempotencyKey` makes a
  retried command (or a retried spawn) return the original result instead of repeating it.
  `scope: "subtree"` acts on an agent and every descendant (pause parents-first, resume
  children-first, stop leaves-first).

## Fan-out and gather

`waitFor: { agents, mode, k?, onDepFailure?, deadlineSec?, onDeadline? }` on a spawn (or
`POST /runs/:id/await`). Modes: `settled` (all terminal, any outcome), `all` (all succeeded),
`any` (first to settle), `quorum` (k successes). Dependency outputs are written into the waiting
agent's sandbox at `/inputs/*.txt` and `/inputs.json`. `notifyOn` delivers a notice to a parent's
inbox when a child settles or is blocked.

## Supervision

`onFailure` / `maxRetries` / `maxConsecutiveFailures` on the spec — see
[Agent SDK § Failure policy](agent-sdk.md#failure-policy). Under alineod a `blocked` agent holds
its sandbox and connection; resolve with `prompt` (retry, optionally with corrective text) or
`stop`, and the **parent** is told through its inbox. A dead bridge is restarted in place, a
reattach is retried once, and an agent that cannot be brought back ends `lost`.

An upstream API error ends a turn early. alineod must record that as a failure, not `success`
(fixed in #296) — if a run "succeeds" with empty output, check the transcript and the model
(see [Troubleshooting](troubleshooting.md)) before trusting the status.

## The durability contract

Do not say "durable" where the docs say "resumable". The table below is the claim; anything not
in it is not built. Authoritative page: `/docs/alineod/concepts/durability-contract`.

| Layer | alineod crash | Container loss / reboot | Disk or host loss |
|---|---|---|---|
| Sandbox session (`client.resume`) | yes | yes, to last `sb.checkpoint()` | no |
| Agent SDK (`reattach`/`resume`) | yes | yes, to last turn checkpoint | no |
| alineod swarm | yes | yes, to last completed turn **for specs with `checkpoint: true`**; otherwise the agent returns on a fresh container with a blank session | no |
| Agent memory | yes | yes (keyed by agent identity) | no — one SQLite file, back it up (`apps/alineod/scripts/backup.ts`) |

Known gaps: no restore onto a different machine; one alineod instance per database; specs with
`approval: "hold"` credential bindings cannot be restored onto a fresh container (agent ends
`lost`); a turn checkpoint covers `/root` only, so non-root agents are not covered. Side effects
are **at-least-once**, not exactly-once.

### The three "snapshots"

| Name | Taken | Carries |
|---|---|---|
| Setup snapshot | once per spec, by `Alineo.start()` | packages + setup steps; an *empty* conversation |
| Turn checkpoint | after each clean turn when `checkpoint: true` | `/root`: Pi session + files — **the conversation** |
| `sb.checkpoint()` | explicitly, Core SDK | whole container, for exec replay |

## Memory

Every agent alineod starts, resumes or reattaches is handed one shared, durable `@alineo-labs/memory`
(SQLite working memory plus optional semantic store) via `engine/memory.ts`. A spawned child gets a
fork of its parent's scope. Scope is the agent's identity (`resourceId`, `teamId`), not its sandbox,
which is why it survives container loss.

## MCP server (`alineo-mcp`)

`packages/mcp` exposes alineod to MCP clients as `{subject}_{verb}` tools: `init`, `spec_add`,
`spec_list`, `spec_remove`, `run_start`, `run_get`, `run_watch`, `run_stop`, `agent_spawn`,
`agent_get`, `agent_prompt`, `agent_steer`, `agent_pause`, `agent_resume`, `agent_stop`,
`result_get`. It needs alineod reachable at `ALINEOD_URL` (default `http://127.0.0.1:4600`);
`init` starts OpenSandbox + alineod locally. Its stdout is the JSON-RPC channel, so anything it
logs is collected, never printed.

## Docs-for-agents

`apps/docs-mcp` (`alineo-docs`) serves `search_docs` / `get_doc` / `list_docs` over
docs.alineo.tech. Read-only — it does not run sandboxes.

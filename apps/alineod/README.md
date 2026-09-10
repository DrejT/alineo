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

```bash
bun run start          # or: bun run dev   (watch mode)
```

Env: `ALINEOD_PORT` (4600), `ALINEOD_DB_PATH`, `ALINEOD_SDK_LEDGER_PATH`, `ALINEOD_WORK_DIR`.

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

## No tests yet

Code only, per the prototype plan. Test surface will follow.

# platform-conversion: turning alineo into a dashboard-controlled platform

> Branch: `platform-conversion`. Status date: 2026-10-02.

## 1. What exists today (capability inventory)

Everything a user can do via the SDK/CLI/workflow package today, and where it lives. This is
the checklist every dashboard feature below maps back to.

| Capability | SDK surface | CLI | alineod HTTP today |
|---|---|---|---|
| spawn (root) | `Alineo.start()` / `Sandbox.sandbox()` | `alineo start` | `POST /runs` |
| spawn (child) | `Alineo.spawn()` (built on `sandbox.fork()`) | `alineo spawn` | `POST /runs/:id/agents` |
| exec (raw shell) | `sb.exec()`, `sb.createSession()`, `sb.execCode()` | — | **missing** |
| checkpoint | `sb.checkpoint()` / `listCheckpoints()` | — | **missing** |
| resume | `Sandbox.resume()` / `Alineo.resume()` | `alineo prompt` (implicitly) | internal only (rehydrate) |
| fork | `sb.fork()` | — | internal only (backs child spawn) |
| attach/reattach | `Sandbox.connect()` / `Alineo.attach/reattach()` | internal (`alineo spawn` self-attach) | internal only |
| steer | `Alineo.steer()` | `alineo steer` | `POST /agents/:id/steer` (+ subtree) |
| pause/resume (agent) | session-control | — | `POST /agents/:id/pause\|resume` (+ subtree) |
| close/stop | `sb.close()` / `Alineo.close()` | `alineo stop` | `POST /agents/:id/stop` (+ subtree) |
| delete (run) | ledger record delete | — | `DELETE /runs/:id` (closes live agents, keeps ledger) |
| resource limits (cpu/mem/gpu) | `SandboxOptions.resources` (required) | via agent spec | spec field only, no dedicated endpoint |
| egress control | `sb.egress.{patch,delete,get}`, `NetworkPolicy` | — | **missing** (spec field only, no runtime route) |
| credential injection | `sb.credentials.{set,patch,remove,listBindings}` | — | **missing** |
| audit ledger (exec_*) + replay | SDK's own `IStorageAdapter` (SQLite/Postgres) | `alineo logs` (one session) | separate from alineod's own swarm ledger |
| swarm ledger + replay | alineod's own SQLite ledger, SSE replay via `Last-Event-ID` | — | `GET /runs/:id/events` |
| workflows (define/run) | `@alineo-labs/workflow` (`workflow().sandbox().pipe()`) | — | **no run registry anywhere** — must be built |
| sessions/transcripts/tool calls | `Alineo.getMessages/getSessionStats/getState` | — | `GET /agents/:id`, `GET /agents/:id/transcript` |
| model config | `Alineo.setModel/getAvailableModels`, `@alineo-labs/model-providers` | via spec | **missing** (catalog package exists, no route) |
| spawnDepth/maxAgents/maxConcurrency | `AgentSpec` fields, enforced in `packages/agent/validation.ts` + alineod budget columns | via spec/flags | enforced, not independently settable per dashboard request |
| swarm tree (parent/child) | `fork()`'s `parentSandboxId` lineage | — | first-class: `agents` table, `GET /runs/:id` |
| permission approval (tool use) | `Alineo.resolvePermission()` | — | event forwarded, **no resolve route** |
| egress approval (human-in-the-loop) | `AgentSpec.env[k].approval:"hold"` + `onEgressRequest` | — | **not wired** (alineod never registers the handler) |
| settings (storage adapter / model / concurrency / secrets / egress rules) | all code-level (`new SQLiteAdapter(...)`, env vars) | — | **no config surface at all**, boot-time env only |

Full detail (file:line citations) is in the four research transcripts this plan was built from;
not reproduced here to keep this file a working document rather than a dump.

## 2. Architecture decision: extend `apps/alineod`, do not build a parallel server

`apps/alineod` ("the swarm control daemon") already implements the hard, stateful part of what
a dashboard needs: a durable swarm-tree projection, a replayable `Last-Event-ID`-aware SSE bus,
idempotent subtree control (pause/resume/stop/steer), crash-only rehydration, and a
Zod-derived OpenAPI spec. It has its own single-writer SQLite db with a process lease — running
a second server against the same storage would violate that "one writer" design, and
re-implementing the projection/SSE/subtree machinery elsewhere would be exactly the "reimplement
sandbox logic" the brief warns against.

**Decision**: add new route modules to `apps/alineod` (`src/routes/*.ts`, following the existing
pattern — thin routes, logic in `src/engine/*.ts`, projections in `src/state/*.ts`), plus a new
`apps/dashboard` app that talks to alineod's HTTP+SSE API (and to OpenSandbox's own metrics
where alineod doesn't carry telemetry — see §4).

What's genuinely new in alineod (not duplicating anything — these are real gaps from §1):

1. **`src/routes/sandboxes.ts` + `src/engine/sandboxes.ts`** — a *second*, independent subsystem
   (not the Pi-agent one) wrapping `@alineo-labs/sandbox` directly for raw sandbox primitives
   alineod never exposed: create (with required resources/egress/credentials), list/get (via the
   existing SDK ledger adapter's `listAllSandboxDetails`/`getSandboxDetails` — no new table
   needed), exec (interactive, over a WebSocket — same shape as `apps/sandbox`'s
   `terminal.ts`/`server/ws/terminal.ts`, which we port rather than reinvent), checkpoint/list
   checkpoints, fork, resume, close, credentials CRUD, egress CRUD, live metrics (WS, mirroring
   `apps/sandbox/server/ws/metrics.ts`'s `sb.watchMetrics()` pattern since alineod's SSE schema
   has no metrics event). A small in-memory live-handle registry (`sandbox-registry.ts`) mirrors
   the existing `engine/registry.ts` pattern for agents.
2. **`GET /runs`** — list-all-runs (alineod only ever supported get-by-id).
3. **`PATCH /agents/:id/permissions/:requestId`** — resolves a pending tool-use permission
   request (`Alineo.resolvePermission`), which alineod forwards as an event today but never lets
   a client answer.
4. **`src/routes/swarms.ts` + `src/engine/swarm-planner.ts`** — natural-language swarm planning
   (§5): turns a prompt into a structured plan via a model-providers call, previewed, then
   realized through the *existing* `createRun`/`spawnAgent` engine functions — no new
   provisioning path, just a planning step in front of the one that exists.
5. **`src/routes/workflows.ts` + `src/engine/workflow-runs.ts`** — `@alineo-labs/workflow` has no
   run registry at all (confirmed: `WorkflowResult` is just `{stdout, vars}`, nothing persisted).
   This is new bookkeeping: a `workflow_runs`/`workflow_steps` table recording each step's
   status as a `WorkflowBuilder` run progresses (via its existing step callbacks), with retry
   re-invoking a failed step's `fn`. This is the one area where "wrap, don't reimplement" has a
   real seam — see §8 for the honesty caveat on how far this goes.
6. **`src/routes/settings.ts`** — mostly read-only (storage adapter choice and model
   provider/concurrency are code/env-level, not reconfigurable at runtime — see §1). Exposes
   what's actually inspectable (`ADMISSION_CONCURRENCY`, DB paths, `@alineo-labs/model-providers`
   catalog) and a small persisted table for the one thing genuinely dashboard-owned: egress
   approval allow-rules.
7. **Auth/CORS middleware**, env-gated (`ALINEOD_DASHBOARD_TOKEN`) — alineod has zero auth today
   by design (trusted localhost caller); a browser-facing surface needs at least a bearer check
   and permissive-but-explicit CORS for the dashboard's origin.

New vocabulary needed (checked by `bun run check:vocabulary`): add `checkpoint` and `metric` to
`SUBJECTS` in `packages/schema/src/vocabulary.ts` (both already read as nouns — `checkpoint` is
currently verb-only, `metric` is new) so `GET /sandboxes/:id/checkpoints` and
`GET .../metrics` pass the HTTP route check. No new verbs needed — every new action route reuses
an existing verb (`checkpoint`, `fork`, `start`, `stop`) or needs none (PATCH with no trailing
segment for permission resolution, by design — see route table in §6).

## 3. New app: `apps/dashboard`

- **Tooling**: Astro 6 + Tailwind v4 (CSS-first, no `tailwind.config`), matching `apps/sandbox`
  (the only *currently live* app with this stack — the original `apps/www` landing site was
  removed from this repo in a prior commit; its source is recoverable from git history at
  `3aaabe5^` and is used here only as a design reference, not a dependency).
- **Design tokens**: start from `apps/sandbox/src/styles/global.css`'s live token set (oklch
  colors, Geist/Geist Mono variable fonts, `--radius-btn`, CSS-var + Tailwind-arbitrary-value
  convention) since it's current and shared with the (removed) landing site's font choice. Layer
  in the landing site's dark "code-window" terminal treatment (`.code-wrapper`/`.code-header`/
  `tok-*` syntax-accent utilities, the one-accent-color-for-strings idiom) recovered via
  `git show 3aaabe5^:apps/www/src/styles/global.css` and `Hero.astro`/`Features.astro`, for
  every terminal/log/event-stream surface — this is the strongest "feels like one product" win
  since it's the landing site's signature visual idiom.
- **Interactivity**: Astro islands using `@astrojs/react` for the stateful pieces (live SSE tree
  view, NL plan preview/edit, forms) — vanilla-TS `mount*()` modules (matching `apps/sandbox`'s
  own convention) for simpler widgets ported near-verbatim: `terminal.ts` (xterm + WS),
  `metricsChart.ts` (canvas sparkline), the event-dispatch table from `agentChat.ts` (tool-call
  cards, permission cards, markdown bubbles) remapped from the SDK's snake_case `AgentEvent`
  names to alineod's dot-namespaced SSE names.
- **Pages**: `/` (sandboxes list), `/sandboxes/new`, `/sandboxes/:id` (terminal / telemetry /
  checkpoints / events tabs), `/sessions` (agents list), `/sessions/:id` (transcript, steer,
  summary), `/swarms` (NL create + list), `/swarms/:id` (live tree), `/workflows`,
  `/workflows/:id`, `/audit` (searchable ledger + replay), `/settings`.
- Every page: loading / empty / error states; works at laptop and wide-screen widths.

## 4. Known gap: no live telemetry source in alineod's event stream

alineod's SSE schema has no metrics event type — CPU/memory is an OpenSandbox/sandbox-layer
concern. The dashboard's sandbox-detail telemetry panel talks to the *new* `sandboxes` WS
telemetry route (§2.1), which wraps `sb.watchMetrics()` directly — same approach
`apps/sandbox/server/ws/metrics.ts` already takes. Agent-level (Pi session) views don't get a
telemetry panel in this plan — only raw sandboxes do, since that's where the SDK exposes it.

## 5. Natural-language swarm creation

`POST /swarms/plan { prompt }` → calls the configured model (via `@alineo-labs/model-providers`)
with a system prompt constraining it to emit a structured plan: list of
`{ role, specName | inlineSpec, task, resources, parent, waitFor? }` nodes, honoring the
project's `spawnDepth`/`maxAgents`/resource defaults. Validated server-side against those limits
*before* it's returned — an over-limit or ambiguous plan comes back with `ambiguous: true` or
`violatesLimits: [...]` instead of silently clamping. The dashboard renders the plan as an
editable preview (React island); nothing is created until the user confirms.

`POST /swarms { plan }` re-validates (never trusts a client-held plan blindly) and realizes it
through the *existing* `createRun` for the root + `spawnAgent` per child, in topological order
respecting `parent`/`waitFor` — i.e. this is a thin orchestration loop over endpoints that
already exist, not a new provisioning path.

## 6. New route table (additive to the existing one)

| Method | Path | Notes |
|---|---|---|
| GET | `/runs` | list all runs |
| POST | `/sandboxes` | create; body: resources (required), egress mode, credentials |
| GET | `/sandboxes` | list (via SDK ledger adapter) |
| GET | `/sandboxes/:id` | detail |
| DELETE | `/sandboxes/:id` | close |
| POST | `/sandboxes/:id/checkpoint` | create checkpoint |
| GET | `/sandboxes/:id/checkpoints` | list |
| POST | `/sandboxes/:id/fork` | fork into new independent sandbox |
| POST | `/sandboxes/:id/credentials` | set/patch binding |
| DELETE | `/sandboxes/:id/credentials/:name` | remove |
| GET/PATCH/DELETE | `/sandboxes/:id/egress` | policy read/patch/delete |
| WS | `/sandboxes/:id/exec` | interactive terminal (ported from apps/sandbox) |
| WS | `/sandboxes/:id/metrics` | live telemetry (ported from apps/sandbox) |
| PATCH | `/agents/:id/permissions/:requestId` | resolve a pending tool-use permission |
| POST | `/swarms/plan` | NL prompt → structured plan (not yet created) |
| POST | `/swarms` | realize a confirmed plan |
| GET | `/workflows` / `/workflows/:id` | run registry (new bookkeeping) |
| POST | `/workflows/:id/retry` | retry a failed step |
| GET | `/settings` | effective config (mostly read-only, see §1) |
| PUT | `/settings/egress-rules` | the one genuinely dashboard-owned setting |

## 7. One dev command

`scripts/dev-platform.ts`: `Bun.spawn`s `apps/alineod` (`bun --watch server.ts`) and
`apps/dashboard` (`astro dev`) together, prefixed/colored output, single Ctrl-C tears both down.
Wired as `bun run dev:platform` at the repo root. Does **not** start OpenSandbox itself (Docker)
— that's `alineo init`, a separate one-time step, documented in the dashboard's own empty state
when no server is reachable.

## 8. Build order

1. Vocabulary additions (`checkpoint`, `metric` as SUBJECTS) + `bun run check:vocabulary` green.
2. alineod: auth/CORS middleware, `GET /runs`, permission-resolve route (smallest, lowest-risk
   additions, prove the extension pattern).
3. alineod: `sandboxes` subsystem (routes + engine + WS terminal/metrics) — the biggest chunk.
4. alineod: swarm planning routes.
5. alineod: workflow run registry (honesty flag: step-level retry re-invokes that step's `fn`
   against a *new* sandbox state derived from the run's last checkpoint if the builder supports
   resuming mid-sequence; if `@alineo-labs/workflow`'s lazy/batched model doesn't allow resuming
   a partially-flushed queue cleanly, retry will re-run the whole workflow and this will be
   stated plainly in the final report rather than silently narrowed).
6. alineod: settings route + egress-rules table.
7. `apps/dashboard` scaffold + design tokens + ported terminal/metrics/event-dispatch modules.
8. `apps/dashboard` pages, wired to the above, in the order: sandboxes → sessions → swarms →
   workflows → audit → settings.
9. `dev-platform.ts` + root script.
10. Real end-to-end pass: start OpenSandbox (needs Docker — checked and launching at plan time),
    run every flow for real, screenshot each into `docs/platform-screenshots/`, fix what's
    broken, re-run. `bun run test` + `bun run typecheck` + `bun run check:vocabulary` must stay
    green; add `apps/alineod/test/` coverage for the new routes.
11. Commit in logical steps per area above. No merge/push to main.

## 9. Explicit non-goals / honesty flags going in

- Egress **approval** (human-in-the-loop hold) resolution over HTTP is attempted but may land
  partial — alineod never wired `onEgressRequest` before; if the full round-trip isn't solid by
  the test pass, it will be reported as not working rather than demoed with a mock.
- Storage adapter **selection** stays code-level (SQLite only for this dashboard) — making it
  config-driven (e.g. Postgres via env) is out of scope unless time remains; current repo has no
  such switch to build on.
- Model config is read-only (catalog browsing via `@alineo-labs/model-providers`) — no
  provider-key management UI, since there's no existing secrets-at-rest mechanism to build on
  beyond the SDK's per-sandbox credential vault (which is sidecar-runtime-only, not a settings
  store).

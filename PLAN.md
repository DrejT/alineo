# platform-conversion: turning alineo into a dashboard-controlled platform

> Branch: `platform-conversion`. Status date: 2026-10-02, architecture revised 2026-10-06 (§2).

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

## 2. Architecture decision: the dashboard has its own server, alineod stays small

> Revised 2026-10-06. The first version of this plan added every dashboard route to
> `apps/alineod`. It was moved out: see `plans/06-10-2026/dashboard-server-migration.md` (local,
> gitignored) for the reasoning. This section is the current decision.

`apps/dashboard/server/` is a separate Elysia + Bun server. It depends on alineo (the SDK
packages, and alineod's public HTTP API). It never opens alineod's database and never imports
alineod's engine, so alineod keeps its single-writer SQLite design and its process lease.

**In the dashboard server:**

1. **Raw sandboxes** (`sandboxes/`, `routes/sandboxes.ts`) — wraps `@alineo-labs/sandbox`
   directly: create, list/get, exec (interactive, over a WebSocket), checkpoint, fork, close,
   credentials, egress, live metrics. It writes to its own ledger (`DASHBOARD_LEDGER_PATH`), so
   the list shows sandboxes created from the dashboard.
2. **Workflow runs** (`workflows/`) — `@alineo-labs/workflow` has no run registry, so this adds
   `workflow_runs` / `workflow_steps` tables in the server's own database.
3. **Swarm planning and realization** (`swarms/`) — plans with `@alineo-labs/model-providers`,
   then realizes through alineod's `POST /runs` and `POST /runs/:id/agents`.
4. **Settings** (`routes/settings.ts`) — read-only effective configuration.
5. **Auth** (`auth.ts`) — bearer token, single-use WebSocket tickets, CORS allowlist. The server
   refuses to start without `DASHBOARD_TOKEN` (loopback-only opt-out).
6. **Passthrough** (`routes/alineod.ts`) — `/runs*` and `/agents/*` are forwarded to alineod
   unparsed and unbuffered, SSE included.

**In alineod** (the two additions that need its own state): `GET /runs` and
`PATCH /agents/:agentId/permissions/:requestId`. alineod gets no auth, no CORS and no
dashboard-only subsystem.

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

## 6. New route table

Owner is the process that serves the route. `/runs*` and `/agents/*` reach alineod through the
dashboard server's passthrough.

| Method | Path | Owner | Notes |
|---|---|---|---|
| GET | `/runs` | alineod | list all runs |
| POST | `/sandboxes` | dashboard server | create; body: resources (required), egress mode, credentials |
| GET | `/sandboxes` | dashboard server | list (via SDK ledger adapter) |
| GET | `/sandboxes/:id` | dashboard server | detail |
| DELETE | `/sandboxes/:id` | dashboard server | close |
| POST | `/sandboxes/:id/checkpoint` | dashboard server | create checkpoint |
| GET | `/sandboxes/:id/checkpoints` | dashboard server | list |
| POST | `/sandboxes/:id/fork` | dashboard server | fork into new independent sandbox |
| POST | `/sandboxes/:id/credentials` | dashboard server | set/patch binding |
| DELETE | `/sandboxes/:id/credentials/:name` | dashboard server | remove |
| GET/PATCH/DELETE | `/sandboxes/:id/egress` | dashboard server | policy read/patch/delete |
| WS | `/sandboxes/:id/exec` | dashboard server | interactive terminal (ported from apps/sandbox) |
| WS | `/sandboxes/:id/metrics` | dashboard server | live telemetry (ported from apps/sandbox) |
| PATCH | `/agents/:id/permissions/:requestId` | alineod | resolve a pending tool-use permission |
| POST | `/swarms/plan` | dashboard server | NL prompt → structured plan (not yet created) |
| POST | `/swarms` | dashboard server | realize a confirmed plan |
| GET | `/workflows` / `/workflows/:id` | dashboard server | run registry (new bookkeeping) |
| POST | `/workflows/:id/retry` | dashboard server | retry a failed step |
| GET | `/settings` | dashboard server | effective config (mostly read-only, see §1) |

## 7. One dev command

`scripts/dev-platform.ts`: `Bun.spawn`s `apps/alineod` (`bun --watch server.ts`), the dashboard
server (`bun --watch server/index.ts`, with `DASHBOARD_ALLOW_NO_AUTH=1` for loopback development)
and `apps/dashboard` (`astro dev`) together, prefixed/colored output, single Ctrl-C tears all
three down.
Wired as `bun run dev:platform` at the repo root. Does **not** start OpenSandbox itself (Docker)
— that's `alineo init`, a separate one-time step, documented in the dashboard's own empty state
when no server is reachable.

## 8. Build order (original — superseded by §2 for where each step lives)

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

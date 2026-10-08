# @alineo-labs/schema

## 0.2.0

### Minor Changes

- f9d1c2e: Three new alineod control-plane events: `agent.admission_queued`, `agent.admission_granted`,
  `agent.admission_timeout`. Backs admission control (backpressure on provisioning): a spawn held
  for a free provisioning slot is now visible in the ledger, including when it fails loudly instead
  of hanging silently.
- e8756ae: `AgentSpec` gains `onFailure?: "ask" | "retry" | "fail"`, `maxRetries?: number`, and
  `maxConsecutiveFailures?: number` — a unified policy for what happens when a turn fails,
  replacing the separately-proposed `onInterrupt` field before it was built twice under two names.
  Default is `"fail"` (unchanged from today's behavior — supervision is opt-in). Two new events:
  `agent.turn_failed`, `agent.supervision_needed`. `InboxQueued`'s `kind` enum gains `"supervision"`
  for the automatic (non-opt-in) parent notification.
- 228d8a6: Add `resourceRefOf(spec)` — the one rule for an agent's memory scope, `resourceId ?? name` plus
  `teamId`, shared by the SDK and alineod — and the `memory` and `fact` subjects to the shared vocabulary, and the wire shapes for alineod's new
  agent-memory routes (`MemoryView`, `MemoryValueBody`, `AddFactBody`, `FactsResponse`,
  `CompactionBody`, …) in `@alineo-labs/schema/alineod`.

  alineod now builds one durable `@alineo-labs/memory` store and hands it to every agent it starts,
  resumes or reattaches, so `Alineo.spawn()` forks a parent's memory into each child — as it already
  did for an SDK caller who set `opts.memory`, but which alineod never did. The routes
  `GET|PUT|DELETE /agents/:id/memory[/:key]`, `GET|POST /agents/:id/facts` and
  `POST /agents/:id/compactions` expose it; the vocabulary check needed the two new subjects to
  accept those paths.

- 316dd94: `ControlScopeBody` (pause/resume), `StopAgentBody`, and `SteerBody` gain an optional
  `idempotencyKey` field, mirroring `SpawnAgentBody`'s existing one. A retried request with the
  same key returns the original response instead of acting twice — `pause`/`resume`/`stop`/`steer`
  previously had no protection against a lost-response retry double-acting. Scope: the named agent
  only — a subtree op does not support per-request idempotency.
- c2a9c22: The ledger envelope, every event definition, and a package that does something with them.

  **`@alineo-labs/schema`** gains the envelope and the event registry:

  ```ts
  interface LedgerEnvelope<T, D> {
    v: 1;
    ts: number;
    type: T;
    runId?: string;
    agentId?: string;
    turnId?: string;
    causedBy?: EventRef;
    durable?: { aggregate: string; seq: number; version: number };
    data: D;
  }
  ```

  Before it, the same idea was written three ways — the SDK's `LedgerEntry` (ordered by
  timestamp), alineod's ledger row (ordered by `seq`), and the harness's bare
  `{ type, ...fields }` stream. A consumer reading one run end to end had to know all three.

  59 events are now defined, namespaced **by subject rather than by emitting layer** —
  `agent.spawned`, not `alineod.agent_spawned`. Someone reading one mixed stream needs to know
  what an event is _about_, not which process produced it. `defineEvent` refuses a name outside
  `<subject>.<past_tense_verb>`, a subject outside `SUBJECTS`, and a duplicate type.

  A second entry point, `@alineo-labs/schema/types`, carries the types with no Zod in the graph,
  so a package with no validator dependency can take the envelope's shape and have it erase at
  compile time.

  **`@alineo-labs/ledger`** is new: `EventSink`, `composeSinks`, `memorySink`, `jsonlSink`,
  `LedgerStorage` + `MemoryStorage`, and the fold helpers the equivalence gate uses.

  A sink is **synchronous and must not throw**. Both constraints come from where sinks sit — on
  the write path of a sandbox operation. An async sink invites a caller to await it, so a slow
  export becomes sandbox backpressure; a throwing sink fails the operation that emitted the
  event, which is exactly backwards.

  Nothing emits envelopes yet. This is the shape, its definitions, and the machinery — the SDK
  and alineod adopt it next.

- d22672b: **BREAKING:** every MCP tool is renamed to `{subject}_{verb}`, dropping the `alineod_` /
  `alineo_` prefixes that named _which binary_ rather than _what the tool acts on_.

  | Before                                                                                                                     | Now                                                                                                          |
  | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `alineod_create_run` · `alineod_get_run` · `alineod_delete_run` · `alineod_watch_events`                                   | `run_start` · `run_get` · `run_stop` · `run_watch`                                                           |
  | `alineod_spawn_agent` · `_get_agent` · `_prompt_agent` · `_steer_agent` · `_pause_agent` · `_resume_agent` · `_stop_agent` | `agent_spawn` · `agent_get` · `agent_prompt` · `agent_steer` · `agent_pause` · `agent_resume` · `agent_stop` |
  | `alineod_get_result`                                                                                                       | `result_get`                                                                                                 |
  | `alineo_add_spec` · `_list_specs` · `_remove_spec` · `alineo_init`                                                         | `spec_add` · `spec_list` · `spec_remove` · `init`                                                            |

  An LLM picking a tool should be able to guess the name. `alineod_create_run` required knowing
  that a daemon called alineod exists.

  `run_stop`, not `run_delete`: the route aborts and closes every live agent but **keeps the
  ledger**. HTTP keeps `DELETE /runs/:runId` — the method carries the verb there; a tool name has
  to say it out loud.

  `@alineo-labs/schema` gains three subjects — `event`, `result`, `transcript` — and one verb,
  `deliver`. All four were already on the wire (`GET /agents/:id/transcript`,
  `GET /runs/:id/events`, `POST /agents/:id/inbox/deliver`); they were vocabulary in use, just not
  written down.

  `scripts/check-vocabulary.ts` now also checks MCP tool names and alineod's HTTP routes, so all
  four surfaces fail CI on an invented name.

- e604a70: **BREAKING:** remove the `StepCheckpointed` event definition (`step.checkpointed`) and the
  `checkpoint → step.checkpointed` entry in the rename table. Nothing writes or reads this event.
  It was the workflow's per-step resumption point, which an early version wrote and later versions
  do not. The matching `LedgerEvent.Checkpoint` member in `@alineo-labs/core` was already removed.

  A store may still hold rows named `checkpoint`. The one-time rename no longer touches them.

- e185452: Add `closeWhen` to a run (plans/07-10-2026/close-when.md). `POST /runs` accepts
  `closeWhen: "explicit" | "quiescent"` (default `"explicit"`, today's exact behavior — a run
  stays open until a client deletes it). A run created with `closeWhen: "quiescent"` closes
  itself, with no client call, the moment every agent in it is terminal and has nothing left to
  deliver — alineod now tracks each run's open/closed state (a new `runs` projection table,
  folded from the new `run.closed` event) and reacts to it.

  New in `@alineo-labs/schema`: `CloseWhen`, the `closeWhen` field on `CreateRunBody` and
  `RunStarted`, the `RunClosed` event, and `closeWhen`/`state` on `TreeView` (`GET /runs/:id`).

  New in `alineo-mcp`: `run_start`'s `closeWhen` parameter, passed straight through to alineod.

  Also fixes a correctness gap in `apps/alineod`'s existing quiescence detection
  (`GET`/`POST /runs/:runId/await`, used by both the bare `closeWhen: "quiescent"` path and
  anyone already polling it): a `done`/`failed` member holding a pending inbox entry (held for
  its next prompt — not the same as a `paused` member, which was already excluded) could read as
  quiescent, even though something is still waiting to be delivered to it. `quiescence()` now
  requires a member's pending inbox to be empty too, not just its state to be terminal.

- 3b47fb1: `AgentSpec` and the permission-policy types move to `@alineo-labs/schema`.

  Both remain re-exported from `alineo`, so every existing import keeps working. What stays in
  `alineo` is what actually does something: `validateAgentSpec()`, `normalizePermissions()`,
  `evaluatePolicy()` and the safe-command lists.

  **alineod stops modelling `AgentSpec` as `z.record(z.string(), z.unknown())`.** It was an
  opaque pass-through on the reasoning that the SDK owns validation — true for validation, and
  not for the wire contract: `apps/alineod/spec/openapi.json` documented the daemon's most important
  request body as "some object". It now carries the real shape, and an invalid spec comes back
  from `POST /runs` as a 400 naming the bad field rather than failing later inside
  `Alineo.start()`. That is a behaviour change: a spec alineod used to accept and fail on is now
  refused up front.

  `AgentSpec` is still kept twice — a documented `interface` and a Zod schema — because the
  interface's doc comments are what a reader sees on hover and `z.infer<>` would erase them. A
  type-level assertion now makes the pair provably identical, failing the build if a field is
  added to one and not the other. It has to read the schema's `shape` rather than `z.infer` of
  the schema: `AgentSpecSchema` is `.loose()`, and an index signature makes every structural
  comparison vacuously true.

- 680bced: alineod's wire contract and `ProjectConfig` move to `@alineo-labs/schema`.

  The wire contract gets its own entry point, `@alineo-labs/schema/alineod` — its `AgentSpec`
  would collide with the root's, and a consumer that only wants the vocabulary has no business
  importing a daemon's request bodies.

  **`alineo-mcp` deletes eleven hand-mirrored interfaces.** They were documented as deliberate —
  "typed against the wire contract, not against alineod's internal Zod schemas" — which was a
  fair objection while those schemas were an app's internals and stops being one now the contract
  is published. The boundary still holds: mcp talks to alineod over HTTP like any other client,
  and the two request bodies keep `spec: Record<string, unknown>`, because an MCP tool receives
  arbitrary JSON from a model and typing it as an `AgentSpec` would claim a guarantee that side
  of the wire cannot make.

  `ProjectConfig` (the shape of `alineo.config.json`) is now published, so someone writing that
  file by hand can get the type from the same place the tooling does. `@alineo-labs/config-shared`
  re-exports it and keeps the mechanism — discovery, precedence, the env overlay.

  Not done: `apps/telemetry` sharing `CliTelemetryEvent`. It has no dependencies at all and is
  deployed by hand onto a VPS, so a workspace dependency would make a standalone service need the
  monorepo built to start — a worse trade than thirteen fields written twice.

- f5f9999: New alineod control-plane event: `agent.turn_interrupted`. Emitted when alineod finds an agent
  still `running` on boot — its turn died with the previous process — before the catch-up poll that
  follows. A crash-interrupted turn now carries a durable record distinct from one that ran
  straight through, whatever catch-up later finds (durability-roadmap.md M1.2).
- be6be44: New package: `@alineo-labs/schema`, holding the `SUBJECTS` and `VERBS` lists that every alineo
  surface derives its names from, plus `isSubject`, `isVerb` and `parseName`.

  Vocabulary only — no event definitions and no wire types yet. The checks that enforce the lists
  land with the surfaces they police (CLI commands and help strings, MCP tools, HTTP routes, event
  types), so a surface cannot ship a name without also shipping the thing that would reject it.

### Patch Changes

- 8734d5f: Add turn-level checkpointing (durability-roadmap.md M3, chunk 3.2) — opt-in via
  `AgentSpec.checkpoint: true`. After every turn that genuinely finishes (never one alineod
  gave up waiting on, even if recorded as a success from leftover partial text — that doesn't
  mean the session file finished flushing), alineod tars the agent's workspace + Pi session file,
  stores it on disk, and records a new `agent.checkpointed { turn, snapshotRef }` ledger event —
  written only once the tarball is confirmed stored, since an event with no file behind it is
  unreachable garbage.

  New in `@alineo-labs/core`: `LedgerEvent.AgentCheckpointed`, and `SandboxHandle.readFileBytes()` —
  a byte-safe file read (no `TextDecoder`) for binary content like a gzip tarball, which the
  existing `readFile()` would corrupt.

  New in `alineo`: `takeCheckpoint()`, `checkpointsPath()`, `CHECKPOINT_ROOT`, and
  `DEFAULT_CHECKPOINT_EXCLUDES`, exported as public API for a standalone SDK caller to use
  directly (`alineo` gets a `minor` bump for this — pre-1.0, so a public API addition is a
  `minor`, not `major`, per the project's own versioning convention).

  Deliberately not `sb.checkpoint()` — that calls OpenSandbox's own snapshot primitive, which on
  the Docker runtime is literally `docker commit` (confirmed against OpenSandbox's source,
  M3's 3.1 research) and measured at 44.3s for a 236MB container. This mechanism tars a few
  directories via `sb.exec()` instead, measured at well under 2s even unfiltered.

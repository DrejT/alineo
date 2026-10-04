/** Status of a sandbox session derived from its ledger events. */
export enum SandboxStatus {
  Running = "running",
  Completed = "completed",
}

/** Derived metadata for a sandbox session, computed from its ledger events. */
export interface SandboxDetails {
  /** User-provided name (or auto-generated). */
  name: string;
  sandboxId: string;
  status: SandboxStatus;
  /** Unix timestamp (ms) of the `sandbox_created` event. */
  startedAt: number;
  /** Unix timestamp (ms) of the `sandbox_closed` event, if the session has ended. */
  completedAt?: number;
  /** Number of exec() calls that completed. */
  execCount: number;
  /**
   * Identifies the logical run this sandbox belongs to. Always present — a fresh
   * `crypto.randomUUID()` if the caller didn't supply one via `SandboxOptions.runId`.
   * A resumed, forked, or restored-from-snapshot sandbox always inherits its origin's
   * `runId` rather than getting a new one, so every sandbox descended from the same
   * root call (directly or via `sb.fork()`/`Alineo.spawn()`/`alineo spawn`) shares it —
   * the mechanism `client.sandboxes.list({ runId })` correlates on.
   */
  runId: string;
  /**
   * Durable resource identity this session's memory should be scoped by — see
   * `@alineo-labs/memory`'s `ResourceRef.resourceId`. Unlike `runId` (present on every
   * session), this is `undefined` unless the caller explicitly set `SandboxOptions.resourceId`.
   * Threaded through the ledger the same way `runId` is (recorded in the `sandbox_created`
   * event's payload, not a dedicated column), and inherited by `resume()`/`fork()`/
   * `restoreSnapshot()` the same way `runId` is.
   */
  resourceId?: string;
  /**
   * Durable team identity this session's memory should be scoped by — see
   * `@alineo-labs/memory`'s `ResourceRef.teamId`. Threaded through the ledger the same way
   * `resourceId` is (recorded in the `sandbox_created` event's payload, not a dedicated
   * column), and inherited by `resume()`/`fork()`/`restoreSnapshot()` the same way. Exists so
   * `episodicRecall()`/`episodicTree()` can be team-scoped — without this, two different
   * teams' sessions sharing a `resourceId` (plausible: `Alineo.resourceRef` defaults
   * `resourceId` to the agent's own name) would have their ledger histories silently merged,
   * since the ledger otherwise has no team concept at all to filter on.
   */
  teamId?: string;
  /**
   * `sandboxId` of the session this one was created from via `sb.fork()`, if any — absent
   * for a top-level `client.sandbox()` session. Lets episodic memory (`@alineo-labs/memory`'s
   * `episodicRecall`) walk a fork lineage rather than only seeing one flat session.
   */
  parentSandboxId?: string;
}

/** Options for filtering session listings. */
export interface ListSandboxOptions {
  status?: SandboxStatus;
  /** Max number of results to return. */
  limit?: number;
  /** Return only sessions that started before this Unix timestamp (ms). */
  before?: number;
  /** Return only sessions belonging to this run — see `SandboxDetails.runId`. */
  runId?: string;
  /** Return only sessions scoped to this resource — see `SandboxDetails.resourceId`. */
  resourceId?: string;
  /** Return only sessions scoped to this team — see `SandboxDetails.teamId`. */
  teamId?: string;
}

/** Events emitted during execution and stored in the ledger. */
export enum LedgerEvent {
  // ── SandboxHandle substrate events ──────────────────────────────────────────────
  /** Emitted when a sandbox is created and reaches Running state. */
  SandboxCreated = "sandbox.created",
  /** Emitted at the start of each exec() or execCode() call. */
  ExecStart = "exec.started",
  /** Streaming output chunk from exec() or execCode(). */
  ExecEvent = "exec.output",
  /** Emitted when an exec() or execCode() call completes. */
  ExecComplete = "exec.completed",
  /** Emitted when checkpoint() captures a snapshot. */
  CheckpointCreated = "sandbox.checkpoint_created",
  /** Emitted when a sandbox is closed. */
  SandboxClosed = "sandbox.closed",
  /** Emitted when pause() freezes the container. */
  SandboxPaused = "sandbox.paused",
  /** Emitted when resume() restores the container to Running. */
  SandboxResumed = "sandbox.resumed",
  /**
   * Emitted by `sb.credentials.set()`/`.patch()`. Payload is binding metadata only
   * (name, host, injection type) — the credential value is never written to the ledger.
   */
  CredentialBound = "credential.bound",
  /** Emitted by `sb.credentials.remove()`. */
  CredentialRevoked = "credential.revoked",
  /**
   * Emitted by `sb.egress.patch()`. Payload is `{ rules: NetworkRule[] }` — the exact rules
   * passed to the sidecar, so `Sandbox.resume()` can fold a still-wanted allowance back into
   * the resumed sandbox's boot policy (egress policy is sidecar-local and does not survive a
   * resume). `sb.fork()` does not carry these.
   */
  EgressRuleAdded = "egress.rule_added",
  /** Emitted by `sb.egress.delete()`. Payload is `{ targets: string[] }`. */
  EgressRuleRemoved = "egress.rule_removed",

  // ── Agent human-in-the-loop events (used by the `alineo` agent SDK) ──────────────
  /**
   * Emitted when the permission gate pauses a tool call for human approval. Payload is
   * `{ requestId, tool, target }` — metadata only; the raw tool arguments (which can carry
   * secrets in a bash command or a file write) are never written to the ledger.
   */
  PermissionRequested = "permission.requested",
  /**
   * Emitted when a `PermissionRequested` reaches a final state — answered by a caller, a
   * batched always/reject decision, a timeout, or a session resume dropping it. Payload is
   * `{ requestId, decision }`. `decision.kind` is one of `PermissionDecision`'s real answers
   * (`once`/`always`/`reject`) for every case except the dropped one, which is `"dropped"` —
   * deliberately not a `PermissionDecision`, because nobody answered it.
   */
  PermissionResolved = "permission.resolved",
}

/** A single event record written to the storage adapter during a session. */
export interface LedgerEntry {
  /** Unix timestamp in milliseconds. */
  ts: number;
  /** SandboxHandle session name. */
  name: string;
  sandboxId: string;
  /** Zero-based index of the step that produced this event. `-1` for session-level events. */
  stepIndex: number;
  /** Parallel branch index, when this step is inside a `parallel()` block. */
  branch?: number;
  event: LedgerEvent;
  /** Event-specific data (step output, snapshot ID, exec text, etc.). */
  payload?: unknown;
  /** Error message, when the event records a failure. */
  error?: string;
}

/** A recorded checkpoint for a sandbox session. */
export interface CheckpointInfo {
  /** OpenSandbox snapshot ID. */
  snapshotId: string;
  /** User-supplied name, if provided when calling `sb.checkpoint(name)`. */
  tag?: string;
  /** Unix timestamp (ms) when the checkpoint was created. */
  createdAt: number;
}

/**
 * Persisted record for a named, reusable sandbox environment.
 * Written once when the environment is first built; updated on rebuild.
 */
export interface EnvironmentRecord {
  /** User-provided environment name. */
  name: string;
  /** OpenSandbox snapshot ID to restore from. */
  snapshotId: string;
  /** Raw image URI resolved at build time. */
  image: string;
  /** Unix timestamp (ms) when the environment was last built. */
  builtAt: number;
}

/**
 * One entry in a generic, two-level-partition append-only ledger — the shared primitive
 * durability-roadmap.md's M3 (3.1b) introduces so a second consumer (alineod's swarm ledger,
 * `apps/alineod/src/state/db.ts`) can depend on the same package the sandbox SDK's own ledger
 * already does, instead of each hand-rolling `bun:sqlite`. Deliberately narrower than
 * `IStorageAdapter`/`LedgerEntry` above: no derived-aggregation methods (`listSandboxDetails`
 * and friends stay specific to the sandbox SDK's own shape), and ordering is always by `seq`
 * (true write order) — never by `ts`, which stays a per-consumer concern. `scope` and `subScope`
 * are deliberately generic names: the sandbox SDK's shape is `(name, sandboxId)`; alineod's is
 * `(runId, agentId)`. Only the access patterns alineod's existing `ledger` table actually uses
 * are supported (filter by `scope` alone, filter by `subScope` alone plus an event filter, or a
 * full unfiltered replay) — not the sandbox SDK's combined `(scope, subScope)` filter, which
 * stays on `IStorageAdapter.readAll()` as it is today.
 */
export interface EngineLedgerEntry {
  /** Primary partition key — e.g. a run id. Required on every entry. */
  scope: string;
  /** Secondary partition key — e.g. an agent id. Omitted/null for a scope-level event. */
  subScope?: string | null;
  ts: number;
  event: string;
  payload?: unknown;
}

/** A stored `EngineLedgerEntry`, with the monotonic sequence number assigned on append. */
export interface EngineLedgerRow extends EngineLedgerEntry {
  seq: number;
}

export interface IEngineLedger {
  /** Run migrations / open connections. Must be called before first use. */
  connect?(): Promise<void>;
  /** Release connections and resources. Call on graceful shutdown. */
  close?(): Promise<void>;
  /** Append one entry and return it with its assigned `seq`. */
  append(entry: EngineLedgerEntry): Promise<EngineLedgerRow>;
  /** Every entry for one `scope`, in `seq` order, optionally only those after a given `seq`. */
  readByScope(scope: string, opts?: { afterSeq?: number }): Promise<EngineLedgerRow[]>;
  /** Every entry for one `subScope`, in `seq` order, optionally filtered to one `event` type. */
  readBySubScope(subScope: string, event?: string): Promise<EngineLedgerRow[]>;
  /** Every entry across every scope, in `seq` order — for a full replay at boot. */
  readAll(): Promise<EngineLedgerRow[]>;
}

/**
 * Persistence interface for session event storage.
 *
 * Implement this interface to plug in any storage backend. alineo ships two
 * official implementations: `@alineo-labs/sqlite` (local dev, zero infra) and
 * `@alineo-labs/postgres` (production).
 *
 * @example
 * ```ts
 * import { SQLiteAdapter } from "@alineo-labs/sqlite";
 * const client = new Sandbox({ baseUrl, adapter: new SQLiteAdapter("./alineo.db") });
 * ```
 */
export interface IStorageAdapter {
  /** Run migrations / open connections. Must be called before first use. */
  connect?(): Promise<void>;
  /** Release connections and resources. Call on graceful shutdown. */
  close?(): Promise<void>;
  /** Persist a single ledger event. Called automatically during execution. */
  append(entry: LedgerEntry): Promise<void>;
  /** Return all events for a specific session, in ascending timestamp order. */
  readAll(name: string, sandboxId: string): Promise<LedgerEntry[]>;
  /** Return the most recent checkpoint entry for a session, or `null` if none exists. */
  lastCheckpoint(name: string, sandboxId: string): Promise<LedgerEntry | null>;
  /** Return details for all sessions with a given name, newest first. */
  listSandboxDetails(name: string, opts?: ListSandboxOptions): Promise<SandboxDetails[]>;
  /** Return details for sessions across all names, newest first. */
  listAllSandboxDetails(opts?: ListSandboxOptions): Promise<SandboxDetails[]>;
  /** Return details for a single session, or `null` if not found. */
  getSandboxDetails(name: string, sandboxId: string): Promise<SandboxDetails | null>;
  /** Delete all ledger events for a session. */
  deleteSandbox(name: string, sandboxId: string): Promise<void>;
  /** Return all checkpoints for a session in creation order. */
  listCheckpoints(name: string, sandboxId: string): Promise<CheckpointInfo[]>;

  // ── Environment records ──────────────────────────────────────────────────

  /** Return the cached record for a named environment, or null if not built yet. */
  getEnvironment(name: string): Promise<EnvironmentRecord | null>;
  /** Upsert an environment record after a successful build. */
  saveEnvironment(record: EnvironmentRecord): Promise<void>;
  /** Remove the record for a named environment. Does not delete the server-side snapshot. */
  deleteEnvironment(name: string): Promise<void>;
  /** Return all environment records, newest first. */
  listEnvironments(): Promise<EnvironmentRecord[]>;
}

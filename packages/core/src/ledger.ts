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
   * root call (directly or via `sb.fork()`/`Alineo.spawn()`/`alineo fork`) shares it —
   * the mechanism `client.sandboxes.list({ runId })` correlates on.
   */
  runId: string;
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
}

/** Events emitted during execution and stored in the ledger. */
export enum LedgerEvent {
  // ── SandboxHandle substrate events ──────────────────────────────────────────────
  /** Emitted when a sandbox is created and reaches Running state. */
  SandboxCreated = "sandbox_created",
  /** Emitted at the start of each exec() or execCode() call. */
  ExecStart = "exec_start",
  /** Streaming output chunk from exec() or execCode(). */
  ExecEvent = "exec_event",
  /** Emitted when an exec() or execCode() call completes. */
  ExecComplete = "exec_complete",
  /** Emitted when checkpoint() captures a snapshot. */
  CheckpointCreated = "checkpoint_created",
  /** Emitted when a sandbox is closed. */
  SandboxClosed = "sandbox_closed",
  /** Emitted when pause() freezes the container. */
  SandboxPaused = "sandbox_paused",
  /** Emitted when resume() restores the container to Running. */
  SandboxResumed = "sandbox_resumed",

  // ── Workflow layer events (used by @alineo-labs/workflow) ────────────────────────
  /** Emitted once when a workflow run starts, before any steps execute. */
  RunStarted = "run_started",
  /** Emitted at the beginning of each step. */
  StepStart = "step_start",
  /** Emitted when a step finishes successfully. */
  StepComplete = "step_complete",
  /** Emitted when a step throws an unrecoverable error. */
  StepFailed = "step_failed",
  /** Emitted when a step's rollback handler completes during saga compensation. */
  StepRolledBack = "step_rolled_back",
  /** Emitted after all steps finish without error. */
  WorkflowComplete = "workflow_complete",
  /** Emitted after rollback completes following a step failure. */
  WorkflowFailed = "workflow_failed",
  /** Durable resumption point written after each successful step. */
  Checkpoint = "checkpoint",
  /** Emitted when a sandbox snapshot is captured mid-run. */
  Snapshot = "snapshot",
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
  /** Error message when `event` is `StepFailed` or `WorkflowFailed`. */
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

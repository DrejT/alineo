import type { IStorageAdapter, SandboxHandle } from "@alineo-labs/core";
import type { Memory, ResourceRef } from "@alineo-labs/memory";
import type { PiAdapter } from "../adapters/pi";
import type { AgentSpec } from "../schema";
import type { AgentSnapshotRecord } from "../snapshots";
import type {
  AgentStream,
  CompactResult,
  PendingPermission,
  PermissionDecision,
  PiMessage,
  PiModel,
  PiSessionState,
  PiSlashCommand,
  SessionStats,
  ThinkingLevel,
} from "../types";
import * as factory from "./factory";
import * as sessionControl from "./session-control";
import * as model from "./model";
import * as introspection from "./introspection";
import * as lifecycle from "./lifecycle";
import type { EgressApprovalGate, EgressRequest, EgressRequestHandler } from "./egress-approval";

export { resolveParentSpawnDepth, resolveParentMaxAgents } from "./validation";

/**
 * A live AI coding agent running inside an OpenSandbox container.
 *
 * Wraps a Pi CLI process (`pi --mode rpc --approve`) in an HTTP bridge so the
 * host can send prompts and receive streamed responses over a stable API,
 * while Pi manages its own tool use, file writes, and code execution inside the
 * sandbox.
 *
 * Create an agent with `Alineo.load(spec)`. Always call `close()` when done
 * to release the underlying sandbox container.
 *
 * @example
 * ```ts
 * import { Alineo } from "alineo";
 *
 * const spec = await Bun.file("./agents/my-agent.json").json();
 * const agent = await Alineo.load(spec, { adapter });
 * try {
 *   for await (const chunk of agent.prompt("Explain this codebase")) {
 *     process.stdout.write(chunk);
 *   }
 * } finally {
 *   await agent.close();
 * }
 * ```
 */
export class Alineo {
  /** OpenSandbox container ID for this agent's sandbox. */
  readonly sandboxId: string;
  readonly name: string;
  /**
   * Direct access to the underlying `SandboxHandle` — full alineo SandboxHandle API, bypasses Pi.
   * Use this to read or write files, run shell commands, or inspect container state
   * independently of the Pi conversation.
   */
  readonly sandbox: SandboxHandle;
  /**
   * `true` when this agent was loaded from a cached snapshot (fast path).
   * `false` on the first load for a given spec, or after `{ rebuild: true }`.
   */
  readonly fromSnapshot: boolean;

  readonly adapter: PiAdapter;
  env: Record<string, string>;
  /**
   * Identifies the logical run this agent's sandbox belongs to — see
   * `SandboxDetails.runId`. Always present; a fresh `crypto.randomUUID()` if not
   * explicitly passed to `load()`/`resume()`. A child from `.spawn()` (and
   * transitively, `alineo fork`) always inherits its parent's `runId`.
   */
  readonly runId: string;
  /**
   * Optional provider-agnostic memory (`@alineo-labs/memory`), wired in via `opts.memory` on
   * `load()`/`resume()`/`attach()`. `undefined` unless explicitly configured — `alineo` never
   * constructs a `Memory` on your own behalf, matching this package's "own the pipeline,
   * don't assume a backend" design. `spawn()` carries the parent's `memory` (if any) onto the
   * child automatically, the same way it force-computes spawn-depth rather than reading it
   * back off the child's own spec.
   */
  memory?: Memory;

  /**
   * Durable team identity for `.resourceRef` — see `AgentSpec.teamId`. `undefined` unless the
   * spec this agent was loaded from set it.
   */
  readonly teamId: string | undefined;

  /**
   * Durable resource identity for `.resourceRef` — see `AgentSpec.resourceId`. Deliberately
   * separate from `.name`: for a spawned child specifically, `.name` gets overwritten to the
   * forked sandbox's auto-generated ledger name (`fork-<parent>-<id>`), which is NOT what
   * memory should be scoped by — see `AgentSpec.resourceId`'s own doc comment for why.
   */
  readonly resourceId: string;

  /**
   * Convenience `ResourceRef` scoping `.memory` calls to this agent. `resourceId`/`teamId`
   * come from `AgentSpec.resourceId`/`AgentSpec.teamId` (`resourceId` defaulting to this
   * agent's `name` when unset) — `load()`/`resume()`/`spawn()` also thread both into the
   * ledger (see each field's own doc comment) so this getter and the agent's own episodic
   * history stay consistent, including across a spawned child whose `.name` differs from its
   * memory identity.
   *
   * Only meaningful once `.memory` is set; pass a different `ResourceRef` explicitly to
   * `.memory` methods instead if this agent's resourceId/teamId aren't the identity you want.
   */
  get resourceRef(): ResourceRef {
    return { resourceId: this.resourceId, teamId: this.teamId };
  }

  /**
   * Present when the spec has `approval: "hold"` credential bindings — the out-of-process
   * gate that holds the sandbox's egress to those hosts until `onEgressRequest` approves.
   * Stopped by `close()`.
   */
  readonly egressGate?: EgressApprovalGate;

  private constructor(
    sandbox: SandboxHandle,
    spec: AgentSpec,
    env: Record<string, string>,
    adapter: PiAdapter,
    fromSnapshot: boolean,
    runId: string,
    egressGate?: EgressApprovalGate,
  ) {
    this.sandbox = sandbox;
    this.sandboxId = sandbox.sandboxId;
    this.name = spec.name;
    this.teamId = spec.teamId;
    this.resourceId = spec.resourceId ?? spec.name;
    this.adapter = adapter;
    this.env = env;
    this.fromSnapshot = fromSnapshot;
    this.runId = runId;
    this.egressGate = egressGate;
  }

  /** Egress requests currently awaiting a decision (see `AgentSpec.env` `approval: "hold"`). */
  pendingEgressRequests(): EgressRequest[] {
    return this.egressGate?.pending() ?? [];
  }

  /**
   * Validate `spec` and return a fully initialised `Alineo`.
   *
   * `spec` is an already-parsed object, not a file path — `alineo` no longer does its own
   * file I/O here (see #184). Read one from disk yourself first (`await
   * Bun.file(path).json()`), fetch it over HTTP, pull it from a database, or build it
   * programmatically — however you get it, pass the object. It's validated internally
   * regardless (via `validateAgentSpec()`), so a raw `JSON.parse()`'d object works fine; you
   * don't need to call `validateAgentSpec()` yourself first unless you want validation errors
   * to surface before any sandbox/network work starts.
   *
   * On first load the Pi CLI is installed inside a `node:22` sandbox, then
   * the sandbox is checkpointed. Subsequent `load()` calls for the same spec
   * restore from that snapshot — skipping the install and starting in ~3s instead
   * of ~90s.
   *
   * Pass `{ rebuild: true }` to force a full reinstall (e.g. after changing
   * the spec's `packages` or `cliVersion`).
   *
   * Pass `{ spawnDepth }` to override the spec's own `spawnDepth` (e.g. a
   * `--depth` CLI flag) — standard flag-beats-config precedence. Same for
   * `{ maxAgents }` and `--max`.
   *
   * Logs timing for each phase to stdout via `[agent]` prefixed lines.
   */
  static async load(
    spec: AgentSpec | Record<string, unknown>,
    opts: {
      adapter: IStorageAdapter;
      rebuild?: boolean;
      spawnDepth?: number;
      maxAgents?: number;
      runId?: string;
      /** Wire a `Memory` instance onto the returned agent — see `Alineo.memory`. */
      memory?: Memory;
      /**
       * Required when the spec has `approval: "hold"` credential bindings — decides each
       * first outbound request to a held host: return `"allow-once"` (reverts at turn end),
       * `"allow-always"` (permanent for this agent's life), or `"deny"`. Enforcement is
       * out-of-process at the egress sidecar; a compromised agent cannot skip it.
       */
      onEgressRequest?: EgressRequestHandler;
    },
  ): Promise<Alineo> {
    const r = await factory.loadAgent(spec, opts);
    const agent = new Alineo(
      r.sandbox,
      r.spec,
      r.env,
      r.adapter,
      r.fromSnapshot,
      r.runId,
      r.egressGate,
    );
    agent.memory = opts.memory;
    return agent;
  }

  /**
   * Reconnect to a previously-created agent whose host process has exited.
   *
   * The sandbox container must still be running. Pi and any installed packages
   * are already present — only the bridge process needs to be restarted.
   * Pi is started with `--continue` so it resumes the most recent session.
   *
   * @param sandboxId  The sandbox ID returned by the original `Alineo.load()`.
   * @param opts.spec  An already-parsed agent spec object — skips file I/O entirely, same as
   *   `load()`. Takes precedence over `opts.specPath` if both are set.
   * @param opts.specPath  Path to the agent spec JSON, read and validated internally. If
   *   neither `opts.spec` nor `opts.specPath` is set, the ledger is queried for the sandbox's
   *   name and the spec is read from `./agents/<name>.json` — this fallback is the one thing
   *   `resume()` can do that `load()` can't, since a resumed sandbox's original spec may not be
   *   in memory anywhere the caller can hand it over.
   *
   * @example
   * ```ts
   * // Original process:
   * const spec = await Bun.file("./agents/hello-agent.json").json();
   * const agent = await Alineo.load(spec, { adapter });
   * console.log(agent.sandboxId); // save this
   * // ... process exits ...
   *
   * // New process:
   * const agent = await Alineo.resume(savedSandboxId, { adapter });
   * for await (const chunk of agent.prompt("What did we discuss earlier?")) {
   *   process.stdout.write(chunk);
   * }
   * await agent.close();
   * ```
   */
  static async resume(
    sandboxId: string,
    opts: {
      adapter: IStorageAdapter;
      spec?: AgentSpec | Record<string, unknown>;
      specPath?: string;
      runId?: string;
      /** Wire a `Memory` instance onto the returned agent — see `Alineo.memory`. */
      memory?: Memory;
    },
  ): Promise<Alineo> {
    const r = await factory.resumeAgent(sandboxId, opts);
    const agent = new Alineo(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot, r.runId);
    agent.memory = opts.memory;
    return agent;
  }

  /**
   * Connect to an already-running sandbox WITHOUT touching its Pi bridge — unlike
   * `resume()`, which kills and restarts the bridge process. Use this when you only
   * need `.spawn()`/`.sandbox`, not `.prompt()`/`.bash()`.
   *
   * The main caller is `alineo fork`: it runs as a fresh CLI process started BY the
   * very Pi bash-tool call it's attaching to (a master agent spawning a child from
   * inside its own turn). Going through `resume()` there would `pkill` the bridge
   * that's currently running the Pi process making the call — self-destructive.
   *
   * The returned `Alineo` has no bridge, so `.prompt()`/`.bash()`/etc. all throw.
   * Its env is read back from `/etc/alineo-env` on the sandbox itself (the ground
   * truth for what's actually running there) rather than re-derived from a spec
   * file, which may not even exist inside this particular sandbox.
   *
   * When `sandboxId` matches `ALINEO_SANDBOX_ID` in this process's own env (true
   * self-attach, e.g. `alineo fork` running from inside its own container),
   * `/etc/alineo-env` is read straight off the local filesystem instead of via
   * `sb.readFile()`. A self-referential exec call would need this sandbox to
   * reach itself through its own externally-facing bridge IP, which Docker's
   * default bridge network generally can't hairpin back to the originating
   * container — sibling-to-sibling traffic works fine, only this exact
   * self-connect case doesn't, and the caller already has the file locally.
   *
   * `opts.resources` sizes a subsequent `.spawn()`'s forked container — the
   * control API doesn't echo back a running sandbox's own resource limits, so
   * there's no way to discover this agent's *actual* footprint here. Defaults to
   * `alineo.config.json`'s `defaults.resources`, same fallback `Alineo.load()` uses
   * for a spec that doesn't set its own.
   */
  static async attach(
    sandboxId: string,
    opts: {
      adapter: IStorageAdapter;
      name: string;
      resources?: { cpu: string; memory: string; gpu?: string };
      /** Wire a `Memory` instance onto the returned agent — see `Alineo.memory`. */
      memory?: Memory;
    },
  ): Promise<Alineo> {
    const r = await factory.attachAgent(sandboxId, opts);
    const agent = new Alineo(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot, r.runId);
    agent.memory = opts.memory;
    return agent;
  }

  /**
   * Fork this agent's live sandbox — filesystem, installed packages, checked-out
   * state, everything currently on disk — into a brand-new independent sandbox
   * running its own Pi bridge, per `childSpecPath`. Unlike `Alineo.load()` (always
   * starts from a spec's own snapshot) or `fork()`/`clone()` below (Pi's own
   * conversation-branching — same container, same bridge, new session branch),
   * this is sandbox-level forking: the child sees exactly what this agent's
   * sandbox sees right now, including any uncommitted work.
   *
   * The child's environment is resolved fresh from its OWN spec — nothing is
   * inherited from this agent except the spawn-depth counter, which is
   * force-computed (`current - 1`) regardless of what the child's spec or
   * `opts.spawnDepth` says. Every name this agent's own env declares is also
   * explicitly `unset` in the shell command that starts the child's bridge, since
   * the forked container's OS-level env still carries whatever was baked in at
   * snapshot time independent of what gets written to `/etc/alineo-env`.
   *
   * Refuses immediately unless this agent's own spawn-depth budget
   * (`ALINEO_SPAWN_DEPTH`, or `opts.spawnDepth` to override it) is a positive
   * integer — `0` means no budget left, `undefined` means spawning was never
   * enabled for this agent.
   *
   * If `ALINEO_MAX_AGENTS` (or `opts.maxAgents`) is set, also refuses once it
   * hits `0` — a separate, optional ceiling on total descendants for this
   * lineage, independent of nesting depth. Unset means uncapped for this
   * dimension; only `spawnDepth` gates whether spawning is allowed at all.
   * Not coordinated across sibling branches spawned in parallel.
   *
   * No install/setup steps run — the child inherits Pi (and anything else)
   * already installed on this agent's sandbox. If the child needs packages this
   * agent's own sandbox doesn't have, add them to a setup step on the spec THIS
   * agent was loaded from, not on the child's spec.
   */
  async spawn(
    childSpecPath: string,
    opts: { spawnDepth?: number; maxAgents?: number } = {},
  ): Promise<Alineo> {
    const r = await factory.spawnChild(this, childSpecPath, opts);
    const child = new Alineo(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot, r.runId);
    // Inherited, not re-derived from the child's own spec — same "force-computed, not
    // read back off the child" precedent spawnDepth/maxAgents already set nearby.
    child.memory = this.memory;
    await factory.forkChildMemory(this.memory, this.resourceRef, child);
    return child;
  }

  // --- streaming ---

  /** Send a prompt to Pi and stream the response. Pi manages its own session context. */
  prompt(
    message: string,
    opts?: {
      streamingBehavior?: "steer" | "followUp";
      inactivityTimeoutMs?: number;
      /**
       * Auto-resolve each `permission_request` on this stream with the handler's decision,
       * instead of the caller wiring `resolvePermission()` by hand. The
       * `permission_request` / `permission_resolved` events still flow through the stream.
       */
      onPermission?: sessionControl.PermissionHandler;
    },
  ): AgentStream {
    return sessionControl.prompt(this, message, opts);
  }

  /**
   * Run a shell command inside Pi's working context. Not incrementally
   * streamed — Pi returns bash output synchronously, so the full output
   * arrives as a single `text` event once the command completes.
   */
  bash(command: string): AgentStream {
    return sessionControl.bash(this, command);
  }

  // --- ack-only commands ---

  /** Steer Pi's current response mid-flight. Waits for Pi's RPC acknowledgment. */
  async steer(message: string): Promise<void> {
    return sessionControl.steer(this, message);
  }

  /** Abort Pi's current operation. */
  async abort(): Promise<void> {
    return sessionControl.abort(this);
  }

  /**
   * Resolve a pending `permission_request` from the agent stream — emitted for each gated
   * tool call when `AgentSpec.permissions` is set to something other than `"auto"`.
   *
   * @example
   * ```ts
   * for await (const ev of agent.prompt("Refactor auth")) {
   *   if (ev.type === "permission_request") {
   *     await agent.resolvePermission(ev.requestId, { kind: "once" });
   *   }
   * }
   * ```
   */
  async resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    return sessionControl.resolvePermission(this, requestId, decision);
  }

  /**
   * Tool calls currently paused awaiting a human decision — useful after reconnecting to a
   * session to discover approvals still outstanding. Each entry is resolvable with
   * `resolvePermission(entry.requestId, …)`.
   */
  async listPendingPermissions(): Promise<PendingPermission[]> {
    return sessionControl.listPendingPermissions(this);
  }

  /** Queue a message to be sent to Pi after it finishes its current task. */
  async followUp(message: string): Promise<void> {
    return sessionControl.followUp(this, message);
  }

  /** Start a fresh Pi session, clearing all prior context. */
  async newSession(): Promise<void> {
    return sessionControl.newSession(this);
  }

  /** Set Pi's reasoning level (for models that support extended thinking). */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return model.setThinkingLevel(this, level);
  }

  /** Enable or disable Pi's automatic context compaction. */
  async setAutoCompaction(enabled: boolean): Promise<void> {
    return sessionControl.setAutoCompaction(this, enabled);
  }

  /**
   * Enable or disable Pi's automatic retry on transient errors (429, 500, 502, 503, 504).
   * Auto-retry is ON by default: 3 attempts with exponential backoff (2 s / 4 s / 8 s).
   * Disable it when you want to handle errors yourself via `auto_retry_start`/`auto_retry_end`
   * events in the stream.
   */
  async setAutoRetry(enabled: boolean): Promise<void> {
    return sessionControl.setAutoRetry(this, enabled);
  }

  /**
   * Abort an in-progress auto-retry immediately. Pi stops waiting and fails the current
   * operation, emitting `auto_retry_end` with `success: false`.
   */
  async abortRetry(): Promise<void> {
    return sessionControl.abortRetry(this);
  }

  /** Abort a currently-executing bash command without cancelling the whole prompt. */
  async abortBash(): Promise<void> {
    return sessionControl.abortBash(this);
  }

  /** Retrieve token usage, cost, and message counts for the current session. */
  async getSessionStats(): Promise<SessionStats> {
    return introspection.getSessionStats(this);
  }

  /** Retrieve the text of Pi's most recent assistant response. Returns `null` if none yet. */
  async getLastAssistantText(): Promise<string | null> {
    return introspection.getLastAssistantText(this);
  }

  /**
   * List the fork entry points available in the current session.
   * Each entry has `entryId` (pass to `fork()`) and `text` (the message at that point).
   */
  async getForkMessages(): Promise<{ entryId: string; text: string }[]> {
    return introspection.getForkMessages(this);
  }

  /** List Pi's available slash commands, including extensions, prompt templates, and skills. */
  async getCommands(): Promise<PiSlashCommand[]> {
    return introspection.getCommands(this);
  }

  /** Set a display name for the current Pi session. */
  async setSessionName(name: string): Promise<void> {
    return sessionControl.setSessionName(this, name);
  }

  /**
   * Control how Pi processes queued steering messages.
   * `"all"` applies all queued steers at once; `"one-at-a-time"` applies them sequentially.
   */
  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    return sessionControl.setSteeringMode(this, mode);
  }

  /**
   * Control how Pi processes queued follow-up messages.
   * `"all"` sends all queued follow-ups at once; `"one-at-a-time"` sends them sequentially.
   */
  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    return sessionControl.setFollowUpMode(this, mode);
  }

  /**
   * Export a static HTML transcript of the current session to the sandbox filesystem.
   * Returns the container path of the generated file — use `agent.sandbox.readFile(path)`
   * to retrieve it.
   */
  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return lifecycle.exportHtml(this, outputPath);
  }

  // --- commands that return data ---

  /**
   * Fork Pi's session at the given entry ID, creating a new branch.
   * Returns the text of the forked message and whether the fork was cancelled.
   */
  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return lifecycle.fork(this, entryId);
  }

  /** Clone the current Pi session into a new branch at the current position. */
  async clone(): Promise<{ cancelled: boolean }> {
    return lifecycle.clone(this);
  }

  /** Switch Pi to a different session file on disk. */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return lifecycle.switchSession(this, sessionPath);
  }

  /** Switch Pi to a specific model. Returns the activated model. */
  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return model.setModel(this, provider, modelId);
  }

  /** Cycle Pi to the next available model. Returns null if only one model is configured. */
  async cycleModel(): Promise<{
    model: PiModel;
    thinkingLevel: ThinkingLevel;
    isScoped: boolean;
  } | null> {
    return model.cycleModel(this);
  }

  /** Cycle Pi's thinking level. Returns null if the current model doesn't support thinking. */
  async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
    return model.cycleThinkingLevel(this);
  }

  /** Manually trigger Pi's context compaction. */
  async compact(customInstructions?: string): Promise<CompactResult> {
    return lifecycle.compact(this, customInstructions);
  }

  /** Retrieve Pi's full conversation history for the current session. */
  async getMessages(): Promise<PiMessage[]> {
    return introspection.getMessages(this);
  }

  /** List all models available to Pi under the current provider configuration. */
  async getAvailableModels(): Promise<PiModel[]> {
    return model.getAvailableModels(this);
  }

  /**
   * Retrieve Pi's current session state: active model, thinking level, streaming/compaction
   * status, queue modes, and session identity. The only piece of Pi's RPC surface with no
   * other way to observe the *current* model or thinking level (as opposed to the full list).
   */
  async getState(): Promise<PiSessionState> {
    return introspection.getState(this);
  }

  // --- env & lifecycle ---

  /**
   * Set or update env vars in the running container. Writes to /etc/alineo-env and restarts
   * the Pi subprocess so it picks up the new env. Waits until Pi is ready before returning.
   */
  async setEnv(vars: Record<string, string>): Promise<void> {
    return lifecycle.setEnv(this, vars);
  }

  /** Retrieve recent bridge logs (ring-buffered, last 200 entries). */
  async getLogs(): Promise<string> {
    return introspection.getLogs(this);
  }

  /** Delete the sandbox container and release all resources. Always call in a `finally` block. */
  async close(): Promise<void> {
    return lifecycle.close(this);
  }
}

export type { AgentSnapshotRecord };

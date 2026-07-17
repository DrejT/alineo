import type { IStorageAdapter, Sandbox } from "@drej/core";
import type { PiAdapter } from "../adapters/pi";
import type { AgentSpec } from "../schema";
import type { AgentSnapshotRecord } from "../snapshots";
import type {
  AgentStream,
  CompactResult,
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

export { resolveParentSpawnDepth, resolveParentMaxAgents } from "./validation";

/**
 * A live AI coding agent running inside an OpenSandbox container.
 *
 * Wraps a Pi CLI process (`pi --mode rpc --approve`) in an HTTP bridge so the
 * host can send prompts and receive streamed responses over a stable API,
 * while Pi manages its own tool use, file writes, and code execution inside the
 * sandbox.
 *
 * Create an agent with `Agent.load(specPath)`. Always call `close()` when done
 * to release the underlying sandbox container.
 *
 * @example
 * ```ts
 * import { Agent } from "@drej/agent";
 *
 * const agent = await Agent.load("./agents/my-agent.json", { adapter });
 * try {
 *   for await (const chunk of agent.prompt("Explain this codebase")) {
 *     process.stdout.write(chunk);
 *   }
 * } finally {
 *   await agent.close();
 * }
 * ```
 */
export class Agent {
  /** OpenSandbox container ID for this agent's sandbox. */
  readonly sandboxId: string;
  readonly name: string;
  /**
   * Direct access to the underlying `Sandbox` — full drej Sandbox API, bypasses Pi.
   * Use this to read or write files, run shell commands, or inspect container state
   * independently of the Pi conversation.
   */
  readonly sandbox: Sandbox;
  /**
   * `true` when this agent was loaded from a cached snapshot (fast path).
   * `false` on the first load for a given spec, or after `{ rebuild: true }`.
   */
  readonly fromSnapshot: boolean;

  readonly adapter: PiAdapter;
  env: Record<string, string>;

  private constructor(
    sandbox: Sandbox,
    spec: AgentSpec,
    env: Record<string, string>,
    adapter: PiAdapter,
    fromSnapshot: boolean,
  ) {
    this.sandbox = sandbox;
    this.sandboxId = sandbox.sandboxId;
    this.name = spec.name;
    this.adapter = adapter;
    this.env = env;
    this.fromSnapshot = fromSnapshot;
  }

  /**
   * Load an agent spec from disk and return a fully initialised `Agent`.
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
    specPath: string,
    opts: { adapter: IStorageAdapter; rebuild?: boolean; spawnDepth?: number; maxAgents?: number },
  ): Promise<Agent> {
    const r = await factory.loadAgent(specPath, opts);
    return new Agent(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot);
  }

  /**
   * Reconnect to a previously-created agent whose host process has exited.
   *
   * The sandbox container must still be running. Pi and any installed packages
   * are already present — only the bridge process needs to be restarted.
   * Pi is started with `--continue` so it resumes the most recent session.
   *
   * @param sandboxId  The sandbox ID returned by the original `Agent.load()`.
   * @param opts.specPath  Path to the agent spec JSON. If omitted, the ledger
   *   is queried for the sandbox name and the spec is loaded from
   *   `./agents/<name>.json`.
   *
   * @example
   * ```ts
   * // Original process:
   * const agent = await Agent.load("./agents/hello-agent.json", { adapter });
   * console.log(agent.sandboxId); // save this
   * // ... process exits ...
   *
   * // New process:
   * const agent = await Agent.resume(savedSandboxId, { adapter });
   * for await (const chunk of agent.prompt("What did we discuss earlier?")) {
   *   process.stdout.write(chunk);
   * }
   * await agent.close();
   * ```
   */
  static async resume(
    sandboxId: string,
    opts: { adapter: IStorageAdapter; specPath?: string },
  ): Promise<Agent> {
    const r = await factory.resumeAgent(sandboxId, opts);
    return new Agent(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot);
  }

  /**
   * Connect to an already-running sandbox WITHOUT touching its Pi bridge — unlike
   * `resume()`, which kills and restarts the bridge process. Use this when you only
   * need `.spawn()`/`.sandbox`, not `.prompt()`/`.bash()`.
   *
   * The main caller is `drejx fork`: it runs as a fresh CLI process started BY the
   * very Pi bash-tool call it's attaching to (a master agent spawning a child from
   * inside its own turn). Going through `resume()` there would `pkill` the bridge
   * that's currently running the Pi process making the call — self-destructive.
   *
   * The returned `Agent` has no bridge, so `.prompt()`/`.bash()`/etc. all throw.
   * Its env is read back from `/etc/drej-env` on the sandbox itself (the ground
   * truth for what's actually running there) rather than re-derived from a spec
   * file, which may not even exist inside this particular sandbox.
   *
   * When `sandboxId` matches `DREJ_SANDBOX_ID` in this process's own env (true
   * self-attach, e.g. `drejx fork` running from inside its own container),
   * `/etc/drej-env` is read straight off the local filesystem instead of via
   * `sb.readFile()`. A self-referential exec call would need this sandbox to
   * reach itself through its own externally-facing bridge IP, which Docker's
   * default bridge network generally can't hairpin back to the originating
   * container — sibling-to-sibling traffic works fine, only this exact
   * self-connect case doesn't, and the caller already has the file locally.
   *
   * `opts.resources` sizes a subsequent `.spawn()`'s forked container — the
   * control API doesn't echo back a running sandbox's own resource limits, so
   * there's no way to discover this agent's *actual* footprint here. Defaults to
   * `drej.config.json`'s `defaults.resources`, same fallback `Agent.load()` uses
   * for a spec that doesn't set its own.
   */
  static async attach(
    sandboxId: string,
    opts: {
      adapter: IStorageAdapter;
      name: string;
      resources?: { cpu: string; memory: string; gpu?: string };
    },
  ): Promise<Agent> {
    const r = await factory.attachAgent(sandboxId, opts);
    return new Agent(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot);
  }

  /**
   * Fork this agent's live sandbox — filesystem, installed packages, checked-out
   * state, everything currently on disk — into a brand-new independent sandbox
   * running its own Pi bridge, per `childSpecPath`. Unlike `Agent.load()` (always
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
   * snapshot time independent of what gets written to `/etc/drej-env`.
   *
   * Refuses immediately unless this agent's own spawn-depth budget
   * (`DREJX_SPAWN_DEPTH`, or `opts.spawnDepth` to override it) is a positive
   * integer — `0` means no budget left, `undefined` means spawning was never
   * enabled for this agent.
   *
   * If `DREJX_MAX_AGENTS` (or `opts.maxAgents`) is set, also refuses once it
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
  ): Promise<Agent> {
    const r = await factory.spawnChild(this, childSpecPath, opts);
    return new Agent(r.sandbox, r.spec, r.env, r.adapter, r.fromSnapshot);
  }

  // --- streaming ---

  /** Send a prompt to Pi and stream the response. Pi manages its own session context. */
  prompt(
    message: string,
    opts?: { streamingBehavior?: "steer" | "followUp"; inactivityTimeoutMs?: number },
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
   * Set or update env vars in the running container. Writes to /etc/drej-env and restarts
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

import type { AgentSpec } from "../schema";
import type { PendingPermission, PermissionDecision } from "../types";
import type { HarnessCapabilities } from "./capabilities";
import type { HarnessEvent } from "./events";
import type { HarnessSandbox } from "./sandbox";

/** One turn to run. */
export interface TurnInput {
  message: string;
  /**
   * How long a turn may go without a real event before it fails. Keep-alive pings do not
   * count. Unset means the adapter's default.
   */
  inactivityTimeoutMs?: number;
  /**
   * Send `message` into the turn that is running, or queue it, instead of starting a turn.
   * Needs the matching capability (`steer` or `followUp`). The returned stream ends with
   * `done` once the harness has accepted the message.
   */
  streamingBehavior?: "steer" | "followUp";
}

/**
 * One harness (Pi, Claude Code, Codex) driven inside a sandbox the SDK provisions.
 *
 * An adapter is created per agent and holds that agent's connection, so one instance
 * serves one sandbox. Create it with `createHarness()`.
 *
 * Contract:
 * - A turn yields exactly one `done` event, last, including after `abort()` and after a
 *   failure. A failure is an `error` event then `done`. `runTurn` does not throw for it.
 * - `steer` and `followUp` exist only when the matching capability is `true`. Calling
 *   `steer` between turns throws. It never queues for the next turn.
 * - A capability declared `false` is never called. Use `requireHarnessCapability()`.
 *
 * @experimental The harness layer is being built. Expect changes before it is stable.
 */
export interface HarnessAdapter {
  /** A label for logs and errors. Never branch on it: branch on `capabilities`. */
  readonly id: string;
  /** Declared by the adapter, never probed. */
  readonly capabilities: HarnessCapabilities;

  /** Install the harness and spec packages. Slow. The result is captured by a snapshot. */
  install(sb: HarnessSandbox, spec: AgentSpec): Promise<void>;
  /**
   * Write config, env and the in-sandbox bridge. Runs on every start, fresh install and
   * snapshot resume alike, so env, model and bridge code stay current.
   */
  configure(
    sb: HarnessSandbox,
    spec: AgentSpec,
    resolvedEnv: Record<string, string>,
    opts?: { resume?: boolean },
  ): Promise<void>;
  /**
   * Start the in-sandbox process. `unsetVars` are cleared in the same command that starts it,
   * so a forked sandbox's baked-in env does not leak into the harness.
   */
  start(sb: HarnessSandbox, opts?: { unsetVars?: string[] }): Promise<void>;
  /** Bind to a process that is already running. Starts nothing. Follow with `waitReady()`. */
  reattach(sb: Pick<HarnessSandbox, "proxy">): Promise<void>;
  /** Resolve once the process answers, or throw after `timeoutMs`. */
  waitReady(timeoutMs?: number): Promise<void>;

  /** Run one turn. See the contract above. */
  runTurn(input: TurnInput): AsyncIterable<HarnessEvent>;
  /** Stop the turn that is running. Its stream ends with `done` and reason `aborted`. */
  abort(): Promise<void>;
  /** Inject a message into the running turn. Present iff `capabilities.steer`. */
  steer?(message: string): Promise<void>;
  /** Queue a message for after the running turn. Present iff `capabilities.followUp`. */
  followUp?(message: string): Promise<void>;

  /** Answer a `permission_request`. */
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
  /** Tool calls paused awaiting a decision. */
  listPendingPermissions(): Promise<PendingPermission[]>;

  /** Close the connections this adapter left open. Call once, as the agent closes. */
  dispose(): void;
}
